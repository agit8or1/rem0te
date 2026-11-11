'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { usePermissions, CAP } from '@/lib/auth';
import {
  Definition, Empty, FilterBar, Figure, Generated, Refused, Section, Table, ago, duration, where,
  useReport, useReportFilters, type Facets, type Ref, type ReportFilters,
} from '@/components/reports/report-kit';

/**
 * Offline time (0.32), measured from OFFLINE monitor alerts — the only
 * recorded history of a computer being unreachable. `isOnline` is a flag with
 * no history, so it is not used. No availability percentage is shown: which
 * computers were monitored, and since when, is not recorded.
 */
interface Comp {
  device: Ref; business: Ref | null; site: Ref | null; offlineMinutes: number; episodes: number; alerts: number; longestMinutes: number;
  stillOffline: boolean; endedByPerson: number; closedWithoutReconnect: number; lastOfflineAt: string;
}
interface Totals { computers: number; offlineMinutes: number; episodes: number; stillOffline: number }
interface Data {
  generatedAt: string; days: number; from: string; to: string; recordsBeginAt: string | null; definition: string;
  totals: Totals;
  bySite: (Totals & { business: Ref | null; site: Ref | null })[];
  computers: Comp[]; computersTotal: number;
  coverage: null | { computers: number; monitored: number; notMonitored: { total: number; rows: { device: Ref; business: Ref | null; site: Ref | null }[] } };
  facets: Facets;
}
const KEYS: (keyof ReportFilters)[] = ['businessId', 'siteId', 'days'];

export default function OfflineTimePage() {
  const { can } = usePermissions();
  const { filters, set, params, ready } = useReportFilters(KEYS);
  const allowed = can(CAP.ALERTS_VIEW);
  const { data, error, isLoading } = useReport<Data>('offline-time', params, ready && allowed);
  const t = data?.totals;
  const cov = data?.coverage;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Offline time" description="How long computers were unreachable, from the offline episodes the Offline monitor recorded." />
      {!allowed ? <Refused error={{ response: { status: 403, data: { message: 'Alert reports need the monitoring:alerts permission.' } } }} /> : (
        <>
          <FilterBar facets={data?.facets} filters={filters} set={set} period report="offline-time" params={params} disabled={!t?.computers} />
          {error ? <Refused error={error} /> : null}
          {data && (
            <Definition>
              <p>{data.definition}</p>
              <p>
                {data.recordsBeginAt ? <>Records begin {new Date(data.recordsBeginAt).toLocaleDateString()} (the oldest offline alert in this view). </> : <>No offline alert has ever been recorded in this view. </>}
                <Generated at={data.generatedAt} />.
              </p>
            </Definition>
          )}
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {data && t && (
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
              <Figure label="Recorded offline time" value={duration(t.offlineMinutes)} hint={`${t.episodes} episode${t.episodes === 1 ? '' : 's'} on ${t.computers} computer${t.computers === 1 ? '' : 's'}`} />
              <Figure label="Offline now" value={t.stillOffline} tone={t.stillOffline ? 'bad' : 'good'} hint="With an open offline alert" />
              {cov ? (
                <>
                  <Figure label="Monitored now" value={`${cov.monitored} / ${cov.computers}`} hint="Computers with an enabled Offline monitor today" />
                  <Figure label="Not monitored" value={cov.notMonitored.total} tone={cov.notMonitored.total ? 'warn' : 'good'} hint="Their offline time is not recorded at all" />
                </>
              ) : (
                <Figure label="Coverage" value="No data" hint="Seeing which computers are monitored needs the View computers permission" />
              )}
            </div>
          )}
          {data && t && t.computers === 0 && (
            <Empty>
              No offline episode was recorded in this period for the computers you can see.
              {cov && cov.monitored === 0 ? ' None of them has an Offline monitor, so none would be: add one under Settings → Monitoring.' : ' That is not proof they were online throughout: only silences longer than the monitor\'s threshold are recorded.'}
            </Empty>
          )}
          {data && t && t.computers > 0 && (
            <>
              <Section title="By site">
                <Table head={['Business · site', 'Computers', 'Episodes', 'Offline time', 'Offline now']} empty="None."
                  rows={data.bySite.map((g) => [where(g.business, g.site), g.computers, g.episodes, duration(g.offlineMinutes), g.stillOffline])} />
              </Section>
              <Section title="By computer" note={data.computersTotal > data.computers.length ? `Showing ${data.computers.length} of ${data.computersTotal}; the export has every computer` : undefined}>
                <Table head={['Computer', 'Business · site', 'Offline time', 'Episodes', 'Longest', 'Last went offline', 'Notes']} empty="None."
                  rows={data.computers.map((c) => [
                    <Link key="d" href={`/endpoints/${c.device.id}?tab=monitoring`} className="font-medium hover:underline">{c.device.name}</Link>,
                    where(c.business, c.site), duration(c.offlineMinutes), c.episodes, duration(c.longestMinutes), ago(c.lastOfflineAt),
                    <span key="n" className="text-xs text-muted-foreground">
                      {[c.stillOffline && 'offline now', c.endedByPerson && `${c.endedByPerson} closed by a person`, c.closedWithoutReconnect && `${c.closedWithoutReconnect} closed without reconnecting (measured to the close)`].filter(Boolean).join('; ') || '—'}
                    </span>,
                  ])} />
              </Section>
            </>
          )}
          {cov && cov.notMonitored.total > 0 && (
            <Section title="Computers with no Offline monitor" note="Nothing is recorded for these; add or re-enable the Offline monitor under Settings → Monitoring">
              <Table head={['Computer', 'Business · site']} empty="None."
                rows={cov.notMonitored.rows.map((r) => [
                  <Link key="d" href={`/endpoints/${r.device.id}?tab=monitoring`} className="font-medium hover:underline">{r.device.name}</Link>, where(r.business, r.site),
                ])} />
              {cov.notMonitored.total > cov.notMonitored.rows.length && <p className="text-xs text-muted-foreground">Showing {cov.notMonitored.rows.length} of {cov.notMonitored.total}.</p>}
            </Section>
          )}
        </>
      )}
    </div>
  );
}
