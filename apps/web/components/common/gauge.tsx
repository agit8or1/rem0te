'use client';

/**
 * Resource gauges, shared by the dashboard's host tiles and a computer's
 * Overview tab.
 *
 * One component for both on purpose: the thresholds at which a number stops
 * being trivia and starts being the reason for the ticket are the same whether
 * the disk belongs to this server or to a customer's laptop, and two
 * implementations would drift apart on the first change to either.
 *
 * Everything here states its own freshness. A gauge is read as "now" — that is
 * what a needle means — so a reading from the last heartbeat has to say so, or
 * it lies more convincingly than a plain number would.
 */

/**
 * Amber past 80%, red past 92%.
 *
 * Not arbitrary: below 80 there is nothing to do, and past ~92 a Windows
 * volume starts failing updates and pagefile growth, which is the point at
 * which someone should be told before the customer notices.
 */
function tone(pct: number) {
  if (pct >= 92) return { bar: 'bg-red-500', text: 'text-red-600', ring: 'stroke-red-500' };
  if (pct >= 80) return { bar: 'bg-amber-500', text: 'text-amber-600', ring: 'stroke-amber-500' };
  return { bar: 'bg-primary', text: 'text-foreground', ring: 'stroke-primary' };
}

function clamp(pct: number) {
  return Math.min(100, Math.max(0, pct));
}

/** A labelled horizontal meter. The workhorse — compact and readable at a glance. */
export function MeterGauge({
  label,
  percent,
  detail,
  footnote,
  unknown,
}: {
  label: string;
  percent: number | null;
  /** The numbers behind the bar, e.g. "11.4 GB of 32 GB". */
  detail?: string;
  /** Freshness, or anything that qualifies the reading. */
  footnote?: string;
  /** Rendered instead of a bar when there is genuinely no reading. */
  unknown?: string;
}) {
  if (percent === null || percent === undefined) {
    return (
      <div className="space-y-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">{label}</span>
        </div>
        <p className="text-xs text-muted-foreground">{unknown ?? 'Not reported'}</p>
      </div>
    );
  }

  const pct = clamp(percent);
  const t = tone(pct);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className={`text-sm font-semibold tabular-nums ${t.text}`}>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${t.bar} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      {detail && <div className="text-[11px] text-muted-foreground tabular-nums">{detail}</div>}
      {footnote && <div className="text-[11px] text-muted-foreground/70">{footnote}</div>}
    </div>
  );
}

/**
 * A compact radial gauge, for the few places where a number needs to carry a
 * tile on its own.
 *
 * `strokeDasharray` on a rotated circle rather than an arc path: one element,
 * no path arithmetic, and it animates without recalculating geometry.
 */
export function RadialGauge({
  percent,
  label,
  sub,
  size = 72,
}: {
  percent: number | null;
  label: string;
  sub?: string;
  size?: number;
}) {
  const pct = percent === null || percent === undefined ? null : clamp(percent);
  const t = tone(pct ?? 0);
  const r = (size - 8) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <div className="flex items-center gap-3">
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
          <circle
            cx={size / 2} cy={size / 2} r={r}
            className="stroke-muted" strokeWidth="6" fill="none"
          />
          {pct !== null && (
            <circle
              cx={size / 2} cy={size / 2} r={r}
              className={`${t.ring} transition-all`} strokeWidth="6" fill="none"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - pct / 100)}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className={`text-sm font-semibold tabular-nums ${t.text}`}>
            {pct === null ? '—' : `${Math.round(pct)}%`}
          </span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-xs font-medium truncate">{label}</div>
        {sub && <div className="text-[11px] text-muted-foreground truncate tabular-nums">{sub}</div>}
      </div>
    </div>
  );
}

/**
 * A throughput sparkline.
 *
 * Scaled to the tallest sample in its own window, not to a fixed ceiling: the
 * useful question is "is this busier than it was a minute ago", and a link
 * whose capacity nobody declared has no meaningful full-scale. The peak is
 * printed so the shape cannot be mistaken for an absolute.
 */
export function Sparkline({
  values,
  className = '',
  height = 28,
}: {
  values: number[];
  className?: string;
  height?: number;
}) {
  if (!values.length) {
    return <div style={{ height }} className="flex items-center text-[11px] text-muted-foreground">sampling…</div>;
  }
  const max = Math.max(...values, 1);
  return (
    <div className={`flex items-end gap-px ${className}`} style={{ height }} aria-hidden="true">
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 min-w-px rounded-sm bg-primary/60"
          style={{ height: `${Math.max(2, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

/** Bytes per second, in the unit a person would say. */
export function rate(bytesPerSec: number | null | undefined) {
  if (bytesPerSec === null || bytesPerSec === undefined) return '—';
  const bits = bytesPerSec * 8;
  if (bits < 1000) return `${Math.round(bits)} b/s`;
  if (bits < 1_000_000) return `${(bits / 1000).toFixed(1)} kb/s`;
  if (bits < 1_000_000_000) return `${(bits / 1_000_000).toFixed(1)} Mb/s`;
  return `${(bits / 1_000_000_000).toFixed(2)} Gb/s`;
}

/** Bytes, in the unit a person would say. */
export function size(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
