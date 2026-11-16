'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { usePermissions, CAP } from '@/lib/auth';
import {
  Definition, Empty, FilterBar, Figure, Generated, Refused, Section, Table, where,
  useReport, useReportFilters, type Facets, type Ref, type ReportFilters,
} from '@/components/reports/report-kit';
import { WARRANTY_GAP_LABEL, WARRANTY_GAPS, WARRANTY_STATE_LABEL, type WarrantyGap, type WarrantyGapReason, type WarrantyState } from '@/lib/hardware-support';

/**
 * Warranty (0.56): every computer's stored hardware warranty end date —
 * expired, ending within 30 / 60 / 90 days, or unknown. The dates are the
 * ones entered on each computer's Hardware card or read from Dell, Lenovo,
 * HP or Apple when a Platform Admin switched that lookup on. The definition
 * is the server's, shown as it is. From 0.61 every computer with no date says
 * why (lib/hardware-support.ts warrantyGap, worked out by the server).
 */
interface Tally { total: number; expired: number; within30: number; within60: number; within90: number; active: number; unknown: number; unknownVirtual: number; unknownBy: Record<WarrantyGapReason, number> }
type Row = {
  device: Ref; business: Ref | null; site: Ref | null; manufacturer: string | null; model: string | null; virtual: boolean;
  state: WarrantyState; daysLeft: number | null; startsAt: string | null; endsAt: string | null; source: string | null; coverage: string | null; checkedAt: string | null;
  gap: WarrantyGap | null;
};
interface Data {
  generatedAt: string; definition: string;
  totals: Tally;
  byBusiness: (Tally & { business: Ref | null })[];
  devices: Row[];
  devicesTotal: number;
  missing: Row[];
  missingTotal: number;
  facets: Facets;
}
const KEYS: (keyof ReportFilters)[] = ['businessId', 'siteId'];
const SOURCE: Record<string, string> = { manual: 'By hand', dell: 'Dell', lenovo: 'Lenovo', hp: 'HP', apple: 'Apple' };
const day = (s: string | null) => (s ? s.slice(0, 10) : '—');

export default function WarrantyReportPage() {
  const { can, isPlatformAdmin } = usePermissions();
  const { filters, set, params, ready } = useReportFilters(KEYS);
  const allowed = can(CAP.COMPUTERS_VIEW);
  const { data, error, isLoading } = useReport<Data>('warranty', params, ready && allowed);
  const t = data?.totals;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Warranty" description="Hardware warranty end dates across the computers you can see: what has expired, what ends soon, and what has no date." />
      {!allowed ? <Refused error={{ response: { status: 403, data: { message: 'The warranty report needs the View computers permission.' } } }} /> : (
        <>
          <FilterBar facets={data?.facets} filters={filters} set={set} report="warranty" params={params} disabled={!t?.total} />
          {error ? <Refused error={error} /> : null}
          {data && <Definition><p>{data.definition} <Generated at={data.generatedAt} />.</p></Definition>}
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {t && t.total === 0 && <Empty>No computers in this view.</Empty>}
          {t && t.total > 0 && (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-4" data-testid="warranty-figures">
                <Figure label="Expired" value={t.expired} tone={t.expired ? 'bad' : undefined} hint="The end date has passed" />
                <Figure label="Ends within 30 days" value={t.within30} tone={t.within30 ? 'warn' : undefined} hint="Not yet ended" />
                <Figure label="Ends within 90 days" value={t.within90} tone={t.within90 ? 'warn' : undefined} hint="Includes the 30- and 60-day windows" />
                <Figure label="Unknown" value={t.unknown} tone={t.unknown ? 'warn' : undefined} hint={`No date stored${t.unknownVirtual ? ` (${t.unknownVirtual} virtual machine${t.unknownVirtual === 1 ? '' : 's'}: no hardware warranty)` : ''}`} />
              </div>
              <Section title="By business">
                <Table
                  head={['Business', 'Computers', 'Expired', 'Within 30 days', 'Within 60 days', 'Within 90 days', 'Running', 'Unknown']}
                  empty="No businesses."
                  rows={data!.byBusiness.map((b) => [b.business?.name ?? 'No business', b.total, b.expired, b.within30, b.within60, b.within90, b.active, b.unknown])}
                />
              </Section>
              {t.unknown - t.unknownVirtual > 0 && (
                <Section title="No warranty date: why" note={data!.missingTotal > data!.missing.length ? `Showing ${data!.missing.length} of ${data!.missingTotal}; the export has every computer` : undefined}>
                  <div className="mb-3 flex flex-wrap gap-2 text-xs" data-testid="warranty-gap-counts">
                    {WARRANTY_GAPS.filter((g) => g !== 'virtual' && t.unknownBy[g]).map((g) => (
                      <span key={g} className="rounded-md border px-2 py-1" data-reason={g}>{WARRANTY_GAP_LABEL[g]}: {t.unknownBy[g]}</span>
                    ))}
                  </div>
                  {t.unknownBy.not_configured > 0 && (
                    <p className="mb-3 text-sm" data-testid="warranty-gap-settings-hint">
                      {t.unknownBy.not_configured} computer{t.unknownBy.not_configured === 1 ? '' : 's'} could be looked up automatically if the vendor&apos;s lookup were switched on{' '}
                      {isPlatformAdmin ? <>in <Link href="/settings/warranty" className="underline">Settings → Warranty</Link>.</> : '— a Platform Admin sets this up in Settings → Warranty.'}
                    </p>
                  )}
                  <Table
                    head={['Computer', 'Business · site', 'Hardware', 'Why there is no date']}
                    empty="Every computer in this view has a warranty date."
                    rows={data!.missing.map((d) => [
                      <Link key="d" href={`/endpoints/${d.device.id}`} className="font-medium hover:underline">{d.device.name}</Link>,
                      where(d.business, d.site),
                      [d.manufacturer, d.model].filter(Boolean).join(' ') || '—',
                      d.gap ? <span key="g" data-reason={d.gap.reason}><span className="font-medium">{WARRANTY_GAP_LABEL[d.gap.reason]}.</span> <span className="text-muted-foreground">{d.gap.text}</span></span> : '—',
                    ])}
                  />
                </Section>
              )}
              <Section title="Expired or ending within 90 days" note={data!.devicesTotal > data!.devices.length ? `Showing ${data!.devices.length} of ${data!.devicesTotal}; the export has every computer` : undefined}>
                <Table
                  head={['Computer', 'Business · site', 'Hardware', 'Warranty', 'Ends', 'Days left', 'Coverage', 'Source']}
                  empty="Nothing in this view has expired or ends within 90 days."
                  rows={data!.devices.map((d) => [
                    <Link key="d" href={`/endpoints/${d.device.id}`} className="font-medium hover:underline">{d.device.name}</Link>,
                    where(d.business, d.site),
                    [d.manufacturer, d.model].filter(Boolean).join(' ') || '—',
                    <span key="s" className={d.state === 'expired' ? 'text-red-600 dark:text-red-400' : 'text-amber-700 dark:text-amber-300'}>{WARRANTY_STATE_LABEL[d.state]}</span>,
                    day(d.endsAt),
                    d.daysLeft ?? '—',
                    d.coverage ?? '—',
                    d.source ? SOURCE[d.source] ?? d.source : '—',
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
