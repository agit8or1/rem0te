'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dashboardApi } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Globe, Info, Maximize2 } from 'lucide-react';

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

// Equirectangular in "world units": linear in both axes, so projection is two
// divisions and needs no projection library. The outline is a local asset, so
// the dashboard never calls a tile server with our customers' whereabouts.
const W = 1000, H = 500;
const projX = (lon: number) => ((lon + 180) / 360) * W;
const projY = (lat: number) => ((90 - lat) / 180) * H;

function ringToPath(ring: number[][]): string {
  let d = '';
  for (let i = 0; i < ring.length; i++) {
    d += `${i === 0 ? 'M' : 'L'}${projX(ring[i][0]).toFixed(1)},${projY(ring[i][1]).toFixed(1)}`;
  }
  return d + 'Z';
}

const placeLabel = (p: Point) =>
  [p.city, p.region, p.countryName ?? p.country].filter(Boolean).join(', ');

export function ClientMap({ businessId }: { businessId?: string }) {
  const [land, setLand] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Point | null>(null);
  const [hover, setHover] = useState<{ p: Point; x: number; y: number } | null>(null);
  const [fitted, setFitted] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);

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

  // Fit the view to where the computers actually are. A fleet in one city on a
  // whole-world projection is three invisible pixels; this is the difference
  // between a map and a decoration. Falls back to the world when there is
  // nothing to fit.
  const view = useMemo(() => {
    if (!fitted || points.length === 0) return { x: 0, y: 0, w: W, h: H };
    const xs = points.map((p) => projX(p.lon));
    const ys = points.map((p) => projY(p.lat));
    let minX = Math.min(...xs), maxX = Math.max(...xs);
    let minY = Math.min(...ys), maxY = Math.max(...ys);
    // Pad generously so markers never touch the edge, and enforce a floor so a
    // single point does not zoom to a meaningless sliver of coastline.
    const padX = Math.max((maxX - minX) * 0.45, 60);
    const padY = Math.max((maxY - minY) * 0.45, 40);
    minX -= padX; maxX += padX; minY -= padY; maxY += padY;
    let w = maxX - minX, h = maxY - minY;
    // Keep the 2:1 aspect so the outline is never stretched.
    if (w / h > 2) { const nh = w / 2; minY -= (nh - h) / 2; h = nh; }
    else { const nw = h * 2; minX -= (nw - w) / 2; w = nw; }
    // Never scroll past the edges of the world.
    minX = Math.max(0, Math.min(minX, W - w));
    minY = Math.max(0, Math.min(minY, H - h));
    return { x: minX, y: minY, w: Math.min(w, W), h: Math.min(h, H) };
  }, [fitted, points]);

  // Marker sizes are in world units, so they must shrink as the view zooms in
  // or a city becomes a blob covering the state.
  const scale = view.w / W;
  const maxTotal = Math.max(1, ...points.map((p) => p.total));
  const radius = (n: number) => (5 + Math.round((Math.sqrt(n) / Math.sqrt(maxTotal)) * 9)) * scale;

  // Null means the caller lacks computers:view — render nothing rather than an
  // empty map, which would imply they have no computers.
  if (!isLoading && data === null) return null;

  const onEnter = (p: Point) => (e: React.MouseEvent) => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return;
    setHover({ p, x: e.clientX - r.left, y: e.clientY - r.top });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          <Globe className="h-4 w-4" />
          Client Locations
          <span className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
            {data && (
              <>
                <Badge variant="secondary" className="text-xs">{data.located} located</Badge>
                {data.unlocatable > 0 && (
                  <Badge variant="outline" className="text-xs" title="Private address, or not yet checked in">
                    {data.unlocatable} unlocatable
                  </Badge>
                )}
              </>
            )}
            {points.length > 0 && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs"
                      onClick={() => setFitted((f) => !f)}>
                <Maximize2 className="h-3 w-3 mr-1" />
                {fitted ? 'World view' : 'Fit to clients'}
              </Button>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="h-[320px] flex items-center justify-center text-sm text-muted-foreground">
            Loading map…
          </div>
        ) : points.length === 0 ? (
          <div className="h-[320px] flex flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
            <span>No computers could be located yet.</span>
            <span className="text-xs max-w-md text-center">
              Locations come from the address a computer checks in from. Machines on private
              networks, or that have not checked in, cannot be placed.
            </span>
          </div>
        ) : (
          <>
            <div ref={wrapRef} className="relative w-full overflow-hidden rounded-md border bg-slate-50 dark:bg-slate-900/40">
              <svg
                viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
                className="w-full h-auto block"
                role="img"
                aria-label={`Map of ${data?.located ?? 0} located computers`}
                onMouseLeave={() => setHover(null)}
              >
                <g>
                  {(land ?? []).map((d, i) => (
                    <path key={i} d={d}
                          className="fill-slate-200 stroke-slate-300 dark:fill-slate-700/60 dark:stroke-slate-600"
                          strokeWidth={0.4 * scale} vectorEffect="non-scaling-stroke" />
                  ))}
                </g>
                {points.map((p) => {
                  const x = projX(p.lon), y = projY(p.lat);
                  const r = radius(p.total);
                  const allOffline = p.online === 0;
                  const isSel = selected?.key === p.key;
                  return (
                    <g key={p.key}
                       onMouseEnter={onEnter(p)}
                       onMouseMove={onEnter(p)}
                       onClick={() => setSelected(isSel ? null : p)}
                       className="cursor-pointer">
                      <circle cx={x} cy={y} r={r * 2}
                              className={allOffline ? 'fill-slate-400/20' : 'fill-emerald-500/20'}>
                        {!allOffline && (
                          <animate attributeName="r" values={`${r * 1.6};${r * 2.4};${r * 1.6}`}
                                   dur="3s" repeatCount="indefinite" />
                        )}
                      </circle>
                      <circle
                        cx={x} cy={y} r={r}
                        className={allOffline ? 'fill-slate-400' : 'fill-emerald-500'}
                        stroke={isSel ? '#0f172a' : '#ffffff'}
                        strokeWidth={isSel ? 2.5 : 1.5}
                        vectorEffect="non-scaling-stroke"
                        strokeDasharray={p.accuracy === 'country' ? '3 2' : undefined}
                      />
                      {p.total > 1 && (
                        <text x={x} y={y + r * 0.36} textAnchor="middle"
                              className="fill-white font-semibold pointer-events-none select-none"
                              style={{ fontSize: `${r * 1.1}px` }}>
                          {p.total}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>

              {hover && (
                <div
                  className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
                  style={{
                    left: Math.min(hover.x + 12, (wrapRef.current?.clientWidth ?? 0) - 210),
                    top: Math.max(hover.y - 10, 4),
                    maxWidth: 200,
                  }}
                >
                  <div className="font-medium">{placeLabel(hover.p)}</div>
                  <div className="text-muted-foreground">
                    {hover.p.total} computer{hover.p.total === 1 ? '' : 's'} · {hover.p.online} online
                  </div>
                  {hover.p.accuracy === 'country' && (
                    <div className="mt-0.5 text-amber-600 dark:text-amber-500">Country-level estimate</div>
                  )}
                  <div className="mt-1 text-muted-foreground">Click for details</div>
                </div>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between gap-3 flex-wrap text-[11px] text-muted-foreground">
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-500" /> online
                </span>
                <span className="flex items-center gap-1">
                  <span className="h-2 w-2 rounded-full bg-slate-400" /> all offline
                </span>
                {(data?.approximate ?? 0) > 0 && (
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full border border-dashed border-slate-500" /> country-level
                  </span>
                )}
              </span>
              {/* CC BY 4.0 requires attribution. */}
              <span>
                IP data ©{' '}
                <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline">
                  DB-IP
                </a>{' '}
                (CC BY 4.0)
              </span>
            </div>

            {(data?.approximate ?? 0) > 0 && (
              <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <Info className="h-3 w-3 mt-0.5 shrink-0" />
                <span>
                  {data!.approximate} marker{data!.approximate === 1 ? '' : 's'} shown dashed
                  {data!.approximate === 1 ? ' is' : ' are'} country-level only — those sit on the
                  country&apos;s centre point, not on the computer.
                </span>
              </p>
            )}

            {selected && (
              <div className="mt-3 rounded-md border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{placeLabel(selected)}</div>
                    <div className="text-xs text-muted-foreground">
                      {selected.total} computer{selected.total === 1 ? '' : 's'} · {selected.online} online
                      {selected.accuracy === 'country' && ' · country-level estimate'}
                    </div>
                  </div>
                  <button onClick={() => setSelected(null)}
                          className="text-xs text-muted-foreground hover:text-foreground">
                    Close
                  </button>
                </div>
                <div className="mt-2 grid gap-1 sm:grid-cols-2">
                  {selected.endpoints.map((e) => (
                    <a key={e.id} href={`/endpoints/${e.id}`}
                       className="flex items-center gap-2 text-xs rounded px-1.5 py-1 hover:bg-muted">
                      <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${e.isOnline ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                      <span className="font-medium truncate">{e.name}</span>
                      {e.businessName && (
                        <span className="text-muted-foreground truncate">· {e.businessName}</span>
                      )}
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
