'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Globe, Plus, Minus, Locate, Info } from 'lucide-react';

type Endpoint = { id: string; name: string; isOnline: boolean; businessName: string | null };
type Point = {
  key: string; lat: number; lon: number;
  city: string | null; region: string | null; country: string; countryName: string | null;
  accuracy: 'city' | 'country';
  total: number; online: number; endpoints: Endpoint[];
};
type MapData = {
  points: Point[]; located: number; unlocatable: number; total: number; approximate: number;
} | null;

// Equirectangular world units. Linear in both axes, so projecting is two
// divisions and needs no projection library — and the outline is a local asset,
// so the dashboard never calls a tile server with our customers' whereabouts.
const W = 1000, H = 500;
const projX = (lon: number) => ((lon + 180) / 360) * W;
const projY = (lat: number) => ((90 - lat) / 180) * H;

const VIEW_W = 1000, VIEW_H = 300;      // rendered aspect, deliberately letterbox-ish
const ASPECT = VIEW_W / VIEW_H;
// 110m geometry stops looking like a map well before this; past ~10x the
// coastline is visibly polygonal, so both the auto-fit and the buttons stop there.
const MIN_Z = 1, MAX_Z = 12;

function ringToPath(ring: number[][]): string {
  let d = '';
  for (let i = 0; i < ring.length; i++) {
    d += `${i === 0 ? 'M' : 'L'}${projX(ring[i][0]).toFixed(2)},${projY(ring[i][1]).toFixed(2)}`;
  }
  return d + 'Z';
}

const placeLabel = (p: Point) =>
  p.city ?? [p.region, p.countryName ?? p.country].filter(Boolean).join(', ');

export function ClientMap({ businessId }: { businessId?: string }) {
  const [land, setLand] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Point | null>(null);
  const [hover, setHover] = useState<{ p: Point; x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-map', businessId ?? 'all'],
    queryFn: () => dashboardApi.map(businessId).then((r) => r.data?.data as MapData),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/world-land-110m.geo.json')
      .then((r) => r.json())
      .then((geo) => {
        if (cancelled) return;
        const paths: string[] = [];
        for (const f of geo.features ?? []) {
          const g = f.geometry;
          if (!g) continue;
          const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
          for (const poly of polys) for (const ring of poly) paths.push(ringToPath(ring));
        }
        setLand(paths);
      })
      .catch(() => setLand([]));
    return () => { cancelled = true; };
  }, []);

  const points = useMemo(() => data?.points ?? [], [data]);

  // Where the fleet is, in world units. A handful of machines in one city on a
  // whole-world projection is three invisible pixels, so this is the default
  // view rather than the globe.
  const home = useMemo(() => {
    if (points.length === 0) return { cx: W / 2, cy: H / 2, zoom: 1 };
    const xs = points.map((p) => projX(p.lon));
    const ys = points.map((p) => projY(p.lat));
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const spanX = Math.max(maxX - minX, 6);
    const spanY = Math.max(maxY - minY, 3);
    // Fit whichever axis is tighter, then back off so markers and labels have air.
    const z = Math.min(W / (spanX * 3.2), (W / ASPECT) / (spanY * 3.2), 7);
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, zoom: Math.max(MIN_Z, z) };
  }, [points]);

  const [cam, setCam] = useState(home);
  useEffect(() => { setCam(home); }, [home]);

  const view = useMemo(() => {
    const vw = W / cam.zoom;
    const vh = vw / ASPECT;
    // Never pan past the edge of the world.
    const cx = Math.min(Math.max(cam.cx, vw / 2), W - vw / 2);
    const cy = Math.min(Math.max(cam.cy, vh / 2), H - vh / 2);
    return { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
  }, [cam]);

  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    setCam((c) => {
      const next = Math.min(MAX_Z, Math.max(MIN_Z, c.zoom * factor));
      if (!anchor || next === c.zoom) return { ...c, zoom: next };
      // Keep the point under the cursor put while zooming.
      const vw = W / c.zoom, vh = vw / ASPECT;
      const wx = c.cx - vw / 2 + anchor.x * vw;
      const wy = c.cy - vh / 2 + anchor.y * vh;
      const nvw = W / next, nvh = nvw / ASPECT;
      return { zoom: next, cx: wx - (anchor.x - 0.5) * nvw, cy: wy - (anchor.y - 0.5) * nvh };
    });
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    });
  };

  const onDown = (e: React.MouseEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, cx: cam.cx, cy: cam.cy };
  };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    const r = wrapRef.current?.getBoundingClientRect();
    if (!d || !r) return;
    const vw = W / cam.zoom, vh = vw / ASPECT;
    setCam((c) => ({
      ...c,
      cx: d.cx - ((e.clientX - d.x) / r.width) * vw,
      cy: d.cy - ((e.clientY - d.y) / r.height) * vh,
    }));
  };
  const endDrag = () => { drag.current = null; };

  // Null means the caller lacks computers:view — render nothing rather than an
  // empty map, which would imply they have no computers.
  if (!isLoading && data === null) return null;

  const scale = view.w / W;                     // world units per rendered unit
  const maxTotal = Math.max(1, ...points.map((p) => p.total));
  const rOf = (n: number) => (4.5 + (Math.sqrt(n) / Math.sqrt(maxTotal)) * 4) * scale;
  // Place labels largest-first, skipping any that would overlap one already
  // drawn. Two labels on top of each other are worse than one, and at low zoom
  // genuinely distinct cities can still land close together.
  const labelled = (() => {
    if (points.length > 25) return new Set<string>();
    const kept: { x: number; y: number; w: number }[] = [];
    const out = new Set<string>();
    const px = view.w / 1000; // world units per rendered px, approximately
    for (const p of [...points].sort((a, b) => b.total - a.total)) {
      const x = projX(p.lon), y = projY(p.lat);
      const w = placeLabel(p).length * 6 * px;
      const clash = kept.some((k) => Math.abs(k.x - x) < (k.w + w) / 2 && Math.abs(k.y - y) < 14 * px);
      if (clash) continue;
      kept.push({ x, y, w });
      out.add(p.key);
    }
    return out;
  })();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
          <Globe className="h-4 w-4" />
          Client Locations
          <span className="ml-auto flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            {data && (
              <>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{data.located} located</Badge>
                {data.unlocatable > 0 && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0"
                         title="Private address, or not yet checked in">
                    {data.unlocatable} unlocatable
                  </Badge>
                )}
              </>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="h-[240px] flex items-center justify-center text-sm text-muted-foreground">
            Loading map…
          </div>
        ) : points.length === 0 ? (
          <div className="h-[240px] flex flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <span>No computers could be located yet.</span>
            <span className="text-xs max-w-md text-center">
              Locations come from the address a computer checks in from. Machines on private
              networks, or that have not checked in, cannot be placed.
            </span>
          </div>
        ) : (
          <>
            <div
              ref={wrapRef}
              className="relative w-full h-[240px] overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700 bg-[#dbeafe] dark:bg-[#0b1729] select-none"
              style={{ cursor: drag.current ? 'grabbing' : 'grab' }}
              onWheel={onWheel}
              onMouseDown={onDown}
              onMouseMove={onMove}
              onMouseUp={endDrag}
              onMouseLeave={() => { endDrag(); setHover(null); }}
            >
              <svg
                viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                preserveAspectRatio="xMidYMid slice"
                className="absolute inset-0 w-full h-full"
                role="img"
                aria-label={`Map of ${data?.located ?? 0} located computers`}
              >
                {/* Land sits clearly above the water rather than melting into it. */}
                <g>
                  {(land ?? []).map((d, i) => (
                    <path
                      key={i}
                      d={d}
                      className="fill-[#f1f5f9] stroke-[#94a3b8] dark:fill-[#1e293b] dark:stroke-[#475569]"
                      strokeWidth={0.8}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </g>

                {points.map((p) => {
                  const x = projX(p.lon), y = projY(p.lat);
                  const r = rOf(p.total);
                  const off = p.online === 0;
                  const isSel = selected?.key === p.key;
                  return (
                    <g key={p.key}
                       onMouseEnter={(e) => {
                         const rc = wrapRef.current?.getBoundingClientRect();
                         if (rc) setHover({ p, x: e.clientX - rc.left, y: e.clientY - rc.top });
                       }}
                       onClick={() => setSelected(isSel ? null : p)}
                       className="cursor-pointer">
                      <circle cx={x} cy={y} r={r * 2.6}
                              className={off ? 'fill-slate-500/15' : 'fill-emerald-500/25'} />
                      <circle
                        cx={x} cy={y} r={r}
                        className={off ? 'fill-slate-500' : 'fill-emerald-500'}
                        stroke={isSel ? '#0f172a' : '#ffffff'}
                        strokeWidth={isSel ? 3 : 2}
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray={p.accuracy === 'country' ? '4 3' : undefined}
                      />
                      {p.total > 1 && (
                        <text x={x} y={y + r * 0.38} textAnchor="middle" fill="#fff"
                              style={{ fontSize: `${r * 1.15}px`, fontWeight: 700 }}
                              className="pointer-events-none select-none">
                          {p.total}
                        </text>
                      )}
                      {labelled.has(p.key) && (
                        // Halo via paint-order so names stay readable over both
                        // land and water without a background box.
                        <text
                          x={x} y={y - r - 3 * scale}
                          textAnchor="middle"
                          className="pointer-events-none select-none fill-slate-900 dark:fill-slate-100"
                          stroke="white"
                          strokeWidth={3}
                          vectorEffect="non-scaling-stroke"
                          paintOrder="stroke"
                          style={{ fontSize: `${11 * scale}px`, fontWeight: 600, strokeOpacity: 0.9 }}
                        >
                          {placeLabel(p)}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              {/* Zoom controls */}
              <div className="absolute right-2 top-2 flex flex-col gap-1">
                {[
                  { icon: Plus, label: 'Zoom in', fn: () => zoomBy(1.6) },
                  { icon: Minus, label: 'Zoom out', fn: () => zoomBy(1 / 1.6) },
                  { icon: Locate, label: 'Fit to clients', fn: () => setCam(home) },
                ].map(({ icon: Icon, label, fn }) => (
                  <button
                    key={label}
                    type="button"
                    aria-label={label}
                    title={label}
                    onClick={(e) => { e.stopPropagation(); fn(); }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="h-7 w-7 grid place-items-center rounded-md border border-slate-300 bg-white/90 text-slate-700 shadow-sm hover:bg-white dark:border-slate-600 dark:bg-slate-800/90 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
              </div>

              {hover && (
                <div
                  className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-lg"
                  style={{
                    left: Math.min(hover.x + 12, (wrapRef.current?.clientWidth ?? 0) - 200),
                    top: Math.max(hover.y - 44, 4),
                    maxWidth: 190,
                  }}
                >
                  <div className="font-medium">{placeLabel(hover.p)}</div>
                  <div className="text-muted-foreground">
                    {hover.p.total} computer{hover.p.total === 1 ? '' : 's'} · {hover.p.online} online
                  </div>
                  {hover.p.accuracy === 'country' && (
                    <div className="text-amber-600 dark:text-amber-500">Country-level estimate</div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-1.5 flex items-center justify-between gap-3 flex-wrap text-[10px] text-muted-foreground">
              <span className="flex items-center gap-2.5">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" /> online
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-slate-500" /> offline
                </span>
                <span>scroll to zoom · drag to pan</span>
              </span>
              {/* CC BY 4.0 requires attribution. */}
              <span>
                IP data ©{' '}
                <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline">DB-IP</a>
              </span>
            </div>

            {(data?.approximate ?? 0) > 0 && (
              <p className="mt-1 flex items-start gap-1 text-[10px] text-muted-foreground">
                <Info className="h-3 w-3 mt-px shrink-0" />
                <span>
                  {data!.approximate} dashed marker{data!.approximate === 1 ? '' : 's'} — country-level
                  only, sitting on the country&apos;s centre point rather than the computer.
                </span>
              </p>
            )}

            {selected && (
              <div className="mt-2 rounded-md border p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{placeLabel(selected)}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {selected.total} computer{selected.total === 1 ? '' : 's'} · {selected.online} online
                    </div>
                  </div>
                  <button onClick={() => setSelected(null)}
                          className="text-xs text-muted-foreground hover:text-foreground">Close</button>
                </div>
                <div className="mt-1.5 grid gap-0.5 sm:grid-cols-2">
                  {selected.endpoints.map((e) => (
                    <a key={e.id} href={`/endpoints/${e.id}`}
                       className="flex items-center gap-1.5 text-xs rounded px-1.5 py-0.5 hover:bg-muted">
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${e.isOnline ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                      <span className="font-medium truncate">{e.name}</span>
                      {e.businessName && <span className="text-muted-foreground truncate">· {e.businessName}</span>}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
