'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/common/page-header';
import { usePermissions, CAP } from '@/lib/auth';
import {
  Definition, FilterBar, Figure, Generated, Refused, Section, Table, Empty, ago, where,
  useReport, useReportFilters, type Facets, type Ref, type ReportFilters,
} from '@/components/reports/report-kit';

/**
 * Agent coverage (0.32): which agent each device runs and at what version,
 * devices without a bound device secret, devices not heard from in N days,
 * and non-Windows devices that have never sent inventory.
 */
interface Summary { total: number; signed: number; standard: number; none: number; noDeviceSecret: number; silent: number; nonWindowsNoInventory: number }
interface Row { device: Ref; business: Ref | null; site: Ref | null; platform: string | null; agent: { type: string; version: string | null }; secret: string; lastSeenAt: string | null; isOnline: boolean; inventoryAt: string | null }
interface List { total: number; rows: Row[] }
interface Data {
  generatedAt: string; silentDays: number;
  definitions: { agent: string; deviceSecret: string; silent: string; nonWindowsNoInventory: string };
  totals: Summary;
  versions: { type: string; version: string | null; count: number }[];
  bySite: (Summary & { business: Ref | null; site: Ref | null })[];
  noDeviceSecret: List; silent: List; nonWindowsNoInventory: List;
  facets: Facets;
}
const KEYS: (keyof ReportFilters)[] = ['businessId', 'siteId', 'silentDays'];
const AGENT: Record<string, string> = { signed: 'Signed agent', standard: 'Standard agent', none: 'No agent report' };
const SECRET: Record<string, string> = { bound: 'Bound', none: 'Not bound', no_rustdesk_record: 'No RustDesk record' };

function DeviceTable({ list, empty, extra }: { list: List; empty: string; extra: { head: string; cell: (r: Row) => React.ReactNode } }) {
  return (
    <>
      <Table head={['Device', 'Business · site', 'Platform', 'Agent', extra.head]} empty={empty}
        rows={list.rows.map((r) => [
          <Link key="d" href={`/endpoints/${r.device.id}`} className="font-medium hover:underline">{r.device.name}</Link>,
          where(r.business, r.site), r.platform ?? 'Not reported', `${AGENT[r.agent.type] ?? r.agent.type}${r.agent.version ? ` ${r.agent.version}` : ''}`, extra.cell(r),
        ])} />
      {list.total > list.rows.length && <p className="text-xs text-muted-foreground">Showing {list.rows.length} of {list.total}; the export has every device.</p>}
    </>
  );
}

export default function AgentCoveragePage() {
  const { can } = usePermissions();
  const { filters, set, params, ready } = useReportFilters(KEYS);
  const allowed = can(CAP.COMPUTERS_VIEW);
  const { data, error, isLoading } = useReport<Data>('agent-coverage', params, ready && allowed);
  const t = data?.totals;

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="Agent coverage" description="Which agent each device runs, and the devices whose agent cannot be relied on." />
      {!allowed ? <Refused error={{ response: { status: 403, data: { message: 'Agent coverage needs the View computers permission.' } } }} /> : (
        <>
          <FilterBar facets={data?.facets} filters={filters} set={set} silent report="agent-coverage" params={params} disabled={!t?.total} />
          {error ? <Refused error={error} /> : null}
          {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {t && t.total === 0 && <Empty>No active devices in this view. Agent coverage is computed from the devices you can see.</Empty>}
          {data && t && t.total > 0 && (
            <>
              <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                <Figure label="Devices" value={t.total} hint={`${t.signed} signed · ${t.standard} standard · ${t.none} no agent report`} />
                <Figure label="No device secret" value={t.noDeviceSecret} tone={t.noDeviceSecret ? 'warn' : 'good'} hint="Heartbeats accepted as online; nothing they report is written" />
                <Figure label={`Not heard from in ${data.silentDays} d`} value={t.silent} tone={t.silent ? 'warn' : 'good'} hint="Includes devices that never checked in" />
                <Figure label="Non-Windows, no inventory" value={t.nonWindowsNoInventory} hint="Installed before the Linux or macOS agent existed" />
              </div>
              <Definition>
                <p>{data.definitions.agent}</p>
                <p>{data.definitions.deviceSecret}</p>
                <p><Generated at={data.generatedAt} />.</p>
              </Definition>
              <Section title="Agent type and version">
                <Table head={['Agent', 'Version', 'Devices']} empty="No devices."
                  rows={data.versions.map((v) => [AGENT[v.type] ?? v.type, v.version ?? '—', v.count])} />
              </Section>
              <Section title="By site">
                <Table head={['Business · site', 'Devices', 'Signed', 'Standard', 'No agent', 'No secret', `Silent ${data.silentDays} d`, 'Non-Windows, no inventory']} empty="No sites."
                  rows={data.bySite.map((g) => [where(g.business, g.site), g.total, g.signed, g.standard, g.none, g.noDeviceSecret, g.silent, g.nonWindowsNoInventory])} />
              </Section>
              <Section title="No device secret">
                <DeviceTable list={data.noDeviceSecret} empty="Every device in this view has a bound device secret."
                  extra={{ head: 'Secret', cell: (r) => SECRET[r.secret] ?? r.secret }} />
              </Section>
              <Section title={`Not heard from in ${data.silentDays} day${data.silentDays === 1 ? '' : 's'}`} note={data.definitions.silent}>
                <DeviceTable list={data.silent} empty={`Every device in this view has sent a heartbeat in the last ${data.silentDays} day${data.silentDays === 1 ? '' : 's'}.`}
                  extra={{ head: 'Last seen', cell: (r) => ago(r.lastSeenAt) }} />
              </Section>
              <Section title="Non-Windows devices with no inventory" note={data.definitions.nonWindowsNoInventory}>
                <DeviceTable list={data.nonWindowsNoInventory} empty="No non-Windows device in this view is missing inventory."
                  extra={{ head: 'Last seen', cell: (r) => ago(r.lastSeenAt) }} />
              </Section>
            </>
          )}
        </>
      )}
    </div>
  );
}
