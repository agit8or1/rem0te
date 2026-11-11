'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { endpointsApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HistoryChart, type HistoryGap, type HistorySeries } from '@/components/common/history-chart';
import type { WorkspaceTab } from './device-model';

/**
 * Performance (0.33): CPU, memory and disk history for one computer, from
 * GET /endpoints/:id/metrics. 24 h is every heartbeat sample (about one every
 * three minutes); 7, 30 and 90 days are hourly mean with the hour's min–max.
 * Each volume comes from the inventory pass, about every six hours. Gaps are
 * whatever the server returned as gaps — this page never fills them.
 */

const RANGES = [
  { key: '24h', label: '24 h' },
  { key: '7d', label: '7 d' },
  { key: '30d', label: '30 d' },
  { key: '90d', label: '90 d' },
] as const;
type RangeKey = (typeof RANGES)[number]['key'];

type Num = (number | null)[];
export interface MetricHistory {
  range: RangeKey;
  resolution: 'raw' | 'hour';
  from: string; to: string;
  bucketSeconds: number; maxGapSeconds: number;
  retention: { rawHours: number; hourlyDays: number };
  series: {
    t: number[]; samples?: number[];
    cpu: Num; memory: Num; disk: Num;
    cpuMin?: Num; cpuMax?: Num; memoryMin?: Num; memoryMax?: Num; diskMin?: Num; diskMax?: Num;
  };
  gaps: HistoryGap[];
  disks: { maxGapSeconds: number; volumes: { drive: string; t: number[]; used: Num; gaps: HistoryGap[] }[] };
}

function stats(v: Num) {
  const xs = v.filter((x): x is number => x !== null);
  if (!xs.length) return null;
  return { min: Math.min(...xs), mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10, max: Math.max(...xs), last: xs[xs.length - 1] };
}

function ChartCard({ title, note, s, testId }: { title: string; note?: string; s: HistorySeries; testId: string }) {
  const st = stats(s.v);
  return (
    <Card data-testid={testId}>
      <CardHeader className="pb-2">
        <div className="flex items-baseline justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {st ? <>latest <span className="font-semibold text-foreground">{st.last}%</span></> : 'no samples'}
          </span>
        </div>
        {note && <p className="text-[11px] text-muted-foreground">{note}</p>}
      </CardHeader>
      <CardContent className="pb-4">
        <HistoryChart s={s} label={title} testId={`${testId}-chart`} />
      </CardContent>
    </Card>
  );
}

export function DevicePerformanceTab({ endpointId, onOpenTab }: { endpointId: string; onOpenTab?: (t: WorkspaceTab) => void }) {
  const [range, setRange] = useState<RangeKey>('24h');
  const q = useQuery<MetricHistory>({
    queryKey: ['endpoint-metrics', endpointId, range],
    queryFn: () => endpointsApi.metrics(endpointId, range).then((r) => r.data?.data),
    refetchInterval: range === '24h' ? 180_000 : false,
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const hourly = d?.resolution === 'hour';
  const base = d ? {
    t: d.series.t, from: Date.parse(d.from), to: Date.parse(d.to), gaps: d.gaps,
    bucketMs: d.bucketSeconds * 1000, maxGapMs: d.maxGapSeconds * 1000,
  } : null;
  const metric = (v: Num, lo?: Num, hi?: Num): HistorySeries | null => (base ? { ...base, v, lo: hourly ? lo : undefined, hi: hourly ? hi : undefined } : null);

  const cpu = d && metric(d.series.cpu, d.series.cpuMin, d.series.cpuMax);
  const mem = d && metric(d.series.memory, d.series.memoryMin, d.series.memoryMax);
  const disk = d && metric(d.series.disk, d.series.diskMin, d.series.diskMax);
  const nothing = d && !d.series.t.length && !d.disks.volumes.length;

  return (
    <div className="space-y-4" data-testid="performance-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Range" className="inline-flex rounded-md border p-0.5" data-testid="metric-range">
          {RANGES.map((r) => (
            <button
              key={r.key} type="button" aria-pressed={range === r.key} data-testid={`metric-range-${r.key}`}
              onClick={() => setRange(r.key)}
              className={`whitespace-nowrap rounded px-3 py-1 text-xs font-medium transition-colors ${range === r.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
            >{r.label}</button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {hourly ? 'Hourly mean; the band is each hour’s lowest to highest sample.' : 'Every heartbeat sample, about one every 3 minutes.'}
          {q.isFetching && ' Updating…'}
        </p>
      </div>

      {q.isError && <p className="text-sm text-destructive">Could not load the history for this computer.</p>}
      {!d && !q.isError && <p className="text-sm text-muted-foreground">Loading…</p>}
      {nothing && (
        <p className="text-sm text-muted-foreground" data-testid="metric-empty">
          No samples in this range. History starts with this computer&apos;s first heartbeat after the server was
          upgraded to 0.33 — earlier heartbeats were not stored — and only from an agent that reports processor,
          memory and disk.
        </p>
      )}

      {d && cpu && mem && disk && (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard title="Processor" s={cpu} testId="metric-cpu" />
          <ChartCard title="Memory used" s={mem} testId="metric-memory" />
          <ChartCard title="System disk used" note="The volume the computer started from, every heartbeat." s={disk} testId="metric-disk" />
          {d.disks.volumes.map((v) => (
            <ChartCard
              key={v.drive}
              title={`Volume ${v.drive} used`}
              note="From the inventory pass, about every 6 hours."
              testId={`metric-volume-${v.drive.replace(/[^A-Za-z0-9]/g, '_')}`}
              s={{ t: v.t, v: v.used, gaps: v.gaps, from: Date.parse(d.from), to: Date.parse(d.to), bucketMs: 0, maxGapMs: d.disks.maxGapSeconds * 1000 }}
            />
          ))}
        </div>
      )}

      {d && (
        <details className="rounded-md border px-3 py-2 text-sm" data-testid="metric-table">
          <summary className="cursor-pointer text-xs font-medium">Show as a table</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs tabular-nums">
              <thead className="text-muted-foreground">
                <tr><th className="py-1 text-left font-medium">Series</th><th className="text-right font-medium">Latest</th><th className="text-right font-medium">Lowest</th><th className="text-right font-medium">Mean</th><th className="text-right font-medium">Highest</th><th className="text-right font-medium">Points</th></tr>
              </thead>
              <tbody>
                {([
                  ['Processor', d.series.cpu, hourly ? d.series.cpuMin : undefined, hourly ? d.series.cpuMax : undefined],
                  ['Memory used', d.series.memory, hourly ? d.series.memoryMin : undefined, hourly ? d.series.memoryMax : undefined],
                  ['System disk used', d.series.disk, hourly ? d.series.diskMin : undefined, hourly ? d.series.diskMax : undefined],
                  ...d.disks.volumes.map((v) => [`Volume ${v.drive}`, v.used, undefined, undefined] as const),
                ] as [string, Num, Num | undefined, Num | undefined][]).map(([name, v, lo, hi]) => {
                  const st = stats(v), l = lo ? stats(lo) : null, h = hi ? stats(hi) : null;
                  const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`);
                  return (
                    <tr key={name} className="border-t">
                      <td className="py-1">{name}</td>
                      <td className="text-right">{pct(st?.last)}</td>
                      <td className="text-right">{pct(l?.min ?? st?.min)}</td>
                      <td className="text-right">{pct(st?.mean)}</td>
                      <td className="text-right">{pct(h?.max ?? st?.max)}</td>
                      <td className="text-right">{v.filter((x) => x !== null).length}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {d.gaps.length} gap{d.gaps.length === 1 ? '' : 's'} with no samples in this range. The mean of hourly means weights every reported hour equally.
          </p>
        </details>
      )}

      <div className="space-y-1 text-[11px] text-muted-foreground">
        <p>
          Shaded stretches are gaps: no samples arrived, because the computer was offline or its agent was not
          reporting. Nothing is drawn across them.
        </p>
        {d && <p>Every sample is kept {d.retention.rawHours} hours; hourly figures and volume samples {d.retention.hourlyDays} days.</p>}
        <p>
          History does not raise alerts. The disk, processor and memory monitors check each heartbeat as it arrives —
          {' '}{onOpenTab ? <button type="button" className="underline underline-offset-2" onClick={() => onOpenTab('monitoring')}>see Monitoring</button> : 'see Monitoring'}.
        </p>
      </div>
    </div>
  );
}
