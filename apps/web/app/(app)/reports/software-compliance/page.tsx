'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { usePermissions, CAP } from '@/lib/auth';
import {
  Definition, Empty, FilterBar, Figure, Generated, Refused, Section, Table, ago, where,
  useReport, useReportFilters, type Facets, type Ref, type ReportFilters,
} from '@/components/reports/report-kit';

/**
 * Software compliance (0.34): per software catalog entry, each Windows
 * computer it applies to — compliant, outdated, missing or unknown — from
 * the newest stored evidence (inventory for display-name rules, or the
 * detection a computer reported when a software plan ran there). The
 * definition is the server's, shown as it is.
 */
interface Tally { total: number; compliant: number; outdated: number; missing: number; unknown: number }
interface Data {
  generatedAt: string; definition: string; staleAfterDays: number; notWindows: number;
  totals: Tally;
  entries: (Tally & { unknownStale: number; entry: { id: string; name: string; packageId: string; version: string; scope: string; business: Ref | null; rule: string | null } })[];
  devices: { entry: Ref; device: Ref; business: Ref | null; site: Ref | null; state: 'outdated' | 'missing' | 'unknown'; stale: boolean; evidence: string | null; evidenceAt: string | null; detectedVersion: string | null }[];
  devicesTotal: number;
  facets: Facets;
}
const KEYS: (keyof ReportFilters)[] = ['businessId', 'siteId'];
const STATE: Record<string, string> = { outdated: 'Outdated', missing: 'Missing', unknown: 'Unknown', compliant: 'Compliant' };
const RULE: Record<string, string> = { display_name: 'Display name', uninstall_key: 'Uninstall key', file_version: 'File version' };
const share = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : 'No data');

export default function SoftwareCompliancePage() {
  const { can } = usePermissions();
  const { filters, set, params, ready } = useReportFilters(KEYS);
  const allowed = can(CAP.COMPUTERS_VIEW);
  const { data, error, isLoading } = useReport<Data>('software-compliance', params, ready && allowed);
  const t = data?.totals;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Software compliance" description="Whether each software catalog entry is installed, at the version its detection rule accepts, on the computers it applies to." />
      {!allowed ? <Refused error={{ response: { status: 403, data: { message: 'Software compliance needs the View computers permission.' } } }} /> : (
        <>
          <FilterBar facets={data?.facets} filters={filters} set={set} report="software-compliance" params={params} disabled={!t?.total} />
          {error ? <Refused error={error} /> : null}
          {data && (
            <Definition>
              <p>{data.definition}</p>
              <p>
                Unknown is a coverage gap, never counted as compliant or as non-compliant.
                {data.notWindows ? ` ${data.notWindows} computer${data.notWindows === 1 ? ' is' : 's are'} not Windows and not counted.` : ''} <Generated at={data.generatedAt} />.
              </p>
            </Definition>
          )}
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {data && data.entries.length === 0 && <Empty>The software catalog has no entries for this view. Add one under <Link className="underline" href="/automation/software">Automation → Software catalog</Link>.</Empty>}
          {t && data!.entries.length > 0 && t.total === 0 && <Empty>No Windows computers in this view. Compliance is computed for the computers you can see; clear the site filter or enroll one.</Empty>}
          {t && t.total > 0 && (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                <Figure label="Compliant" value={share(t.compliant, t.total - t.unknown)} tone={t.total - t.unknown === 0 ? undefined : t.compliant / (t.total - t.unknown) >= 0.9 ? 'good' : t.compliant / (t.total - t.unknown) >= 0.6 ? 'warn' : 'bad'}
                  hint={`${t.compliant} of ${t.total - t.unknown} entry × computer pairs with evidence`} />
                <Figure label="Outdated" value={t.outdated} tone={t.outdated ? 'warn' : undefined} hint="Found, at a version the rule does not accept" />
                <Figure label="Missing" value={t.missing} tone={t.missing ? 'warn' : undefined} hint="Not found" />
                <Figure label="Unknown" value={t.unknown} tone={t.unknown ? 'warn' : undefined} hint={`No evidence, or none newer than ${data!.staleAfterDays} days`} />
              </div>
              <Section title="By catalog entry">
                <Table
                  head={['Software', 'Version', 'Catalog', 'Rule', 'Computers', 'Compliant', 'Outdated', 'Missing', 'Unknown', 'Unknown (stale)']}
                  empty="No entries."
                  rows={data!.entries.map((e) => [
                    <Link key="e" href={`/automation/software/${e.entry.id}`} className="font-medium hover:underline">{e.entry.name}</Link>,
                    <span key="v" className="font-mono">{e.entry.version}</span>,
                    e.entry.scope === 'global' ? 'Global' : e.entry.business?.name ?? 'Business',
                    e.entry.rule ? RULE[e.entry.rule] ?? e.entry.rule : '—',
                    e.total, e.compliant, e.outdated, e.missing, e.unknown, e.unknownStale,
                  ])}
                />
              </Section>
              <Section title="Computers needing attention" note={data!.devicesTotal > data!.devices.length ? `Showing ${data!.devices.length} of ${data!.devicesTotal}; the export has every computer` : undefined}>
                <Table
                  head={['Computer', 'Business · site', 'Software', 'State', 'Detected version', 'Evidence', 'Evidence age']}
                  empty="Every computer in this view has every catalog entry it should."
                  rows={data!.devices.map((d) => [
                    <Link key="d" href={`/endpoints/${d.device.id}?tab=software`} className="font-medium hover:underline">{d.device.name}</Link>,
                    where(d.business, d.site),
                    d.entry.name,
                    <span key="s" className={d.state === 'unknown' ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'}>{STATE[d.state] ?? d.state}{d.stale ? ' (stale)' : ''}</span>,
                    d.detectedVersion ?? '—',
                    d.evidence === 'agent' ? 'Software plan' : d.evidence === 'inventory' ? 'Inventory' : '—',
                    d.evidenceAt ? ago(d.evidenceAt) : '—',
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
