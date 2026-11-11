'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * A percentage-over-time chart (0.33, metric history). Hand-drawn SVG like the
 * gauges beside it — the app has no chart library and one line needs none.
 *
 * Built around one rule: **a gap is drawn as a gap.** The line breaks wherever
 * the server says there were no samples, the gap is shaded and labelled, and
 * hovering it says "no samples" rather than a value. Nothing is interpolated
 * or carried across it — a line drawn over eight silent hours would claim the
 * machine was fine while nobody knew.
 *
 * Single series per chart (the card title names it, so no legend box), in the
 * theme's primary hue; text stays in the foreground/muted tokens. An hourly
 * series draws the mean as the line and the hour's min–max as a 10 % wash.
 * Hover or arrow keys move a crosshair that snaps to the nearest point.
 */

export interface HistoryGap { from: string; to: string }

export interface HistorySeries {
  /** Point times, epoch ms (bucket starts when bucketMs > 0). */
  t: number[];
  v: (number | null)[];
  lo?: (number | null)[];
  hi?: (number | null)[];
  gaps: HistoryGap[];
  from: number;
  to: number;
  /** 0 for instantaneous samples; 3 600 000 for hourly buckets (plotted mid-hour). */
  bucketMs: number;
  /** Consecutive points further apart than this are not joined. */
  maxGapMs: number;
}

const H = 140;
const M = { top: 8, right: 10, bottom: 22, left: 36 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Tick times on clean local boundaries for the window's length. */
function ticks(from: number, to: number): { t: number; label: string }[] {
  const span = to - from;
  const day = 86_400_000;
  const step = span <= 1.5 * day ? 6 * 3_600_000 : span <= 8 * day ? day : span <= 31 * day ? 7 * day : 15 * day;
  const d = new Date(from);
  if (step < day) d.setMinutes(0, 0, 0); else d.setHours(0, 0, 0, 0);
  let t = d.getTime();
  if (step < day) { while (new Date(t).getHours() % 6 !== 0 || t < from) t += 3_600_000; }
  else while (t < from) t += day;
  const out: { t: number; label: string }[] = [];
  for (; t <= to; t += step) {
    const x = new Date(t);
    out.push({
      t,
      label: step < day
        ? x.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : x.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    });
  }
  return out;
}

export function fmtWhen(t: number, bucketMs: number) {
  const d = new Date(t);
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const time = (x: Date) => x.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return bucketMs ? `${date}, ${time(d)}–${time(new Date(t + bucketMs))}` : `${date}, ${time(d)}`;
}

export function HistoryChart({ s, label, testId }: { s: HistorySeries; label: string; testId?: string }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const patternId = `gap-${useId().replace(/:/g, '')}`;
  const [hover, setHover] = useState<{ x: number; idx: number | null; gap: { from: number; to: number } | null } | null>(null);

  const W = Math.max(width, 200);
  const iw = W - M.left - M.right, ih = H - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - s.from) / Math.max(1, s.to - s.from)) * iw;
  const y = (v: number) => M.top + (1 - Math.min(100, Math.max(0, v)) / 100) * ih;
  const mid = (t: number) => t + s.bucketMs / 2;
  const gaps = useMemo(() => s.gaps.map((g) => ({ from: Date.parse(g.from), to: Date.parse(g.to) })), [s.gaps]);

  // Runs of joinable points: a null, or a step longer than maxGapMs, ends one.
  const runs = useMemo(() => {
    const out: number[][] = [];
    let cur: number[] = [];
    for (let i = 0; i < s.t.length; i++) {
      if (s.v[i] === null) { if (cur.length) out.push(cur); cur = []; continue; }
      if (cur.length && s.t[i] - s.t[cur[cur.length - 1]] > Math.max(s.maxGapMs, s.bucketMs)) { out.push(cur); cur = []; }
      cur.push(i);
    }
    if (cur.length) out.push(cur);
    return out;
  }, [s.t, s.v, s.maxGapMs, s.bucketMs]);

  const line = (run: number[]) => run.map((i, k) => `${k ? 'L' : 'M'}${x(mid(s.t[i])).toFixed(1)},${y(s.v[i] as number).toFixed(1)}`).join('');
  const band = (run: number[]) => {
    if (!s.lo || !s.hi) return '';
    const ok = run.filter((i) => s.lo![i] !== null && s.hi![i] !== null);
    if (ok.length < 2) return '';
    const top = ok.map((i, k) => `${k ? 'L' : 'M'}${x(mid(s.t[i])).toFixed(1)},${y(s.hi![i] as number).toFixed(1)}`).join('');
    const bottom = [...ok].reverse().map((i) => `L${x(mid(s.t[i])).toFixed(1)},${y(s.lo![i] as number).toFixed(1)}`).join('');
    return `${top}${bottom}Z`;
  };

  const nearest = (px: number) => {
    const t = s.from + ((px - M.left) / iw) * (s.to - s.from);
    const gap = gaps.find((g) => t >= g.from && t <= g.to) ?? null;
    if (gap || !s.t.length) return { idx: null, gap };
    let lo = 0, hi = s.t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (mid(s.t[m]) < t) lo = m; else hi = m; }
    const idx = Math.abs(mid(s.t[lo]) - t) <= Math.abs(mid(s.t[hi]) - t) ? lo : hi;
    return { idx, gap: null };
  };
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = Math.min(M.left + iw, Math.max(M.left, e.clientX - r.left));
    setHover({ x: px, ...nearest(px) });
  };
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!s.t.length || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End')) return;
    e.preventDefault();
    const cur = hover?.idx ?? s.t.length - 1;
    const idx = e.key === 'Home' ? 0 : e.key === 'End' ? s.t.length - 1 : Math.min(s.t.length - 1, Math.max(0, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
    setHover({ x: x(mid(s.t[idx])), idx, gap: null });
  };

  // Thinned to one label per ~64px, so a phone-width chart is not a row of overprinted dates.
  const tk = ticks(s.from, s.to).filter((k, i, all) => {
    const every = Math.max(1, Math.ceil(all.length / Math.max(1, Math.floor(iw / 64))));
    return i % every === 0 && x(k.t) >= M.left - 2 && x(k.t) <= M.left + iw + 2;
  });
  const values = s.v.filter((v): v is number => v !== null);
  const summary = values.length
    ? `${label}: ${values.length} points, lowest ${Math.min(...values)}%, highest ${Math.max(...values)}%, ${gaps.length} gap${gaps.length === 1 ? '' : 's'} with no samples.`
    : `${label}: no samples in this range.`;
  const hv = hover?.idx !== null && hover?.idx !== undefined ? hover.idx : null;

  return (
    <div ref={box} className="relative w-full" data-testid={testId}>
      {width > 0 && (
        <svg
          width={W} height={H} role="img" aria-label={summary} tabIndex={0}
          className="block touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)} onKeyDown={onKey} onBlur={() => setHover(null)}
        >
          <defs>
            <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" className="stroke-muted-foreground/25" strokeWidth="2" />
            </pattern>
          </defs>
          {[0, 50, 100].map((g) => (
            <g key={g}>
              <line x1={M.left} x2={M.left + iw} y1={y(g)} y2={y(g)} className="stroke-border" strokeWidth="1" />
              <text x={M.left - 6} y={y(g)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">{g}%</text>
            </g>
          ))}
          {tk.map((k) => (
            <text key={k.t} x={x(k.t)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px] tabular-nums">{k.label}</text>
          ))}
          {gaps.map((g, i) => {
            const x0 = Math.max(M.left, x(g.from)), x1 = Math.min(M.left + iw, x(g.to));
            if (x1 - x0 < 1) return null;
            return (
              <g key={i} data-gap="">
                <rect x={x0} y={M.top} width={x1 - x0} height={ih} fill={`url(#${patternId})`} />
                {x1 - x0 > 56 && <text x={(x0 + x1) / 2} y={M.top + ih / 2} dy="0.32em" textAnchor="middle" className="fill-muted-foreground text-[10px]">No data</text>}
              </g>
            );
          })}
          {runs.map((run, i) => <path key={`b${i}`} d={band(run)} className="fill-primary/10" />)}
          {runs.map((run, i) => run.length > 1
            ? <path key={`l${i}`} d={line(run)} fill="none" className="stroke-primary" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            : <circle key={`l${i}`} cx={x(mid(s.t[run[0]]))} cy={y(s.v[run[0]] as number)} r="3" className="fill-primary" />)}
          {hover && (
            <line x1={hover.x} x2={hover.x} y1={M.top} y2={M.top + ih} className="stroke-muted-foreground/60" strokeWidth="1" />
          )}
          {hv !== null && s.v[hv] !== null && (
            <circle cx={x(mid(s.t[hv]))} cy={y(s.v[hv] as number)} r="4" className="fill-primary stroke-card" strokeWidth="2" />
          )}
        </svg>
      )}
      {hover && (hv !== null || hover.gap) && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-md border bg-popover px-2 py-1 text-[11px] shadow-sm"
          style={{ left: Math.min(Math.max(0, hover.x - 70), W - 150), width: 150 }}
          role="status"
        >
          {hover.gap ? (
            <>
              <div className="font-medium">No samples</div>
              <div className="text-muted-foreground">{fmtWhen(hover.gap.from, 0)} – {fmtWhen(hover.gap.to, 0)}</div>
              <div className="text-muted-foreground">Offline or not reporting</div>
            </>
          ) : hv !== null && (
            <>
              <div className="font-semibold tabular-nums">{s.v[hv] === null ? 'Not reported' : `${s.v[hv]}%`}{s.lo && s.v[hv] !== null ? ' mean' : ''}</div>
              {s.lo && s.hi && s.lo[hv] !== null && <div className="tabular-nums text-muted-foreground">{s.lo[hv]}% – {s.hi[hv]}%</div>}
              <div className="text-muted-foreground">{fmtWhen(s.t[hv], s.bucketMs)}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
