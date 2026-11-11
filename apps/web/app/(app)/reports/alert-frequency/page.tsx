'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { usePermissions, CAP } from '@/lib/auth';
import {
  Definition, RetentionNote, Empty, FilterBar, Figure, Generated, Refused, Section, Table, duration, where,
  useReport, useReportFilters, type Facets, type Ref, type ReportFilters, type RetentionCoverage,
} from '@/components/reports/report-kit';

/**
 * Alert frequency (0.32): alerts raised per business, site, computer and
 * monitor type over a chosen period, with time to resolve where resolved.
 */
interface Summary {
  raised: number; critical: number; warning: number; info: number; inMaintenance: number; open: number;
  resolved: number; resolvedByPerson: number; resolvedByMonitor: number;
  medianResolveMinutes: number | null; meanResolveMinutes: number | null; longestResolveMinutes: number | null;
}
interface Data {
  generatedAt: string; days: number; from: string; to: string; retention?: RetentionCoverage;
  definitions: { raised: string; resolve: string };
  totals: Summary;
  byBusiness: (Summary & { business: Ref | null })[];
  bySite: (Summary & { business: Ref | null; site: Ref | null })[];
  byComputer: (Summary & { business: Ref | null; site: Ref | null; device: Ref | null })[];
  byComputerTotal: number;
  byMonitor: (Summary & { kind: string })[];
  facets: Facets;
}
const KEYS: (keyof ReportFilters)[] = ['businessId', 'siteId', 'days'];
const KIND: Record<string, string> = {
  OFFLINE: 'Offline', DISK_FREE: 'Disk space', CPU_HIGH: 'Processor', MEMORY_HIGH: 'Memory', SERVICE_STOPPED: 'Service stopped',
  EVENT_MATCH: 'Event log', REBOOT_PENDING: 'Restart pending', SITE_OUTAGE: 'Site outage',
};
const head = ['Raised', 'Critical', 'Warning', 'Info', 'Open', 'Resolved', 'Median to resolve', 'Longest'];
const cells = (g: Summary) => [g.raised, g.critical, g.warning, g.info, g.open, g.resolved, duration(g.medianResolveMinutes), duration(g.longestResolveMinutes)];

export default function AlertFrequencyPage() {
  const { can } = usePermissions();
  const { filters, set, params, ready } = useReportFilters(KEYS);
  const allowed = can(CAP.ALERTS_VIEW);
  const { data, error, isLoading } = useReport<Data>('alert-frequency', params, ready && allowed);
  const t = data?.totals;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Alert frequency" description="How often each business, site, computer and monitor raised alerts, and how long they took to resolve." />
      {!allowed ? <Refused error={{ response: { status: 403, data: { message: 'Alert reports need the monitoring:alerts permission.' } } }} /> : (
        <>
          <FilterBar facets={data?.facets} filters={filters} set={set} period report="alert-frequency" params={params} disabled={!t?.raised} />
          {error ? <Refused error={error} /> : null}
          {data && <RetentionNote r={data.retention} />}
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {data && t && t.raised === 0 && (
            <Empty>No alert was raised in this period for the devices you can see. Alerts are raised by monitors (Settings → Monitoring); a business with no monitors has no alerts to count.</Empty>
          )}
          {data && t && t.raised > 0 && (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                <Figure label="Alerts raised" value={t.raised} hint={`${t.critical} critical · ${t.warning} warning · ${t.info} info`} />
                <Figure label="Still open" value={t.open} tone={t.open ? 'warn' : 'good'} hint={t.inMaintenance ? `${t.inMaintenance} raised in a maintenance window` : 'None in a maintenance window'} />
                <Figure label="Median time to resolve" value={duration(t.medianResolveMinutes)} hint={t.resolved ? `Over ${t.resolved} resolved; mean ${duration(t.meanResolveMinutes)}` : 'None resolved yet'} />
                <Figure label="Resolved by" value={`${t.resolvedByMonitor} / ${t.resolvedByPerson}`} hint="the monitor / a person" />
              </div>
              <Definition>
                <p>{data.definitions.raised}</p>
                <p>{data.definitions.resolve}</p>
                <p>From {new Date(data.from).toLocaleString()} to {new Date(data.to).toLocaleString()}. <Generated at={data.generatedAt} />.</p>
              </Definition>
              <Section title="By monitor type">
                <Table head={['Monitor type', ...head]} empty="None." rows={data.byMonitor.map((g) => [KIND[g.kind] ?? g.kind, ...cells(g)])} />
              </Section>
              {data.byBusiness.length > 1 && (
                <Section title="By business">
                  <Table head={['Business', ...head]} empty="None." rows={data.byBusiness.map((g) => [g.business?.name ?? 'No business', ...cells(g)])} />
                </Section>
              )}
              <Section title="By site">
                <Table head={['Business · site', ...head]} empty="None." rows={data.bySite.map((g) => [where(g.business, g.site), ...cells(g)])} />
              </Section>
              <Section title="By computer" note={data.byComputerTotal > data.byComputer.length ? `Showing ${data.byComputer.length} of ${data.byComputerTotal}; the export has every alert` : undefined}>
                <Table head={['Computer', 'Business · site', ...head]} empty="None."
                  rows={data.byComputer.map((g) => [
                    g.device ? <Link key="d" href={`/endpoints/${g.device.id}?tab=monitoring`} className="font-medium hover:underline">{g.device.name}</Link> : <span key="d" className="text-muted-foreground">Site-wide</span>,
                    where(g.business, g.site), ...cells(g),
                  ])} />
              </Section>
            </>
          )}
        </>
      )}
    </div>
  );
}
