'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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

// world-basemap.json, produced by scripts/gen-basemap.mjs.
type RawCountry = { n: string; a: string; c: number; m: number; k: number; l: [number, number] | null; r: number[][] };
type RawState = { n: string; s: string | null; p: string; k: number; l: [number, number] | null; r: number[][] };
type Shape = { name: string; short: string | null; country?: string; rank: number; at: [number, number] | null; d: string };
type Basemap = { countries: (Shape & { fill: [string, string] })[]; states: Shape[] };

// Equirectangular world units. Linear in both axes, so projecting is two
// divisions and needs no projection library — and the outline is a local asset,
// so the dashboard never calls a tile server with our customers' whereabouts.
const W = 1000, H = 500;
const projX = (lon: number) => ((lon + 180) / 360) * W;
const projY = (lat: number) => ((90 - lat) / 180) * H;

const VIEW_W = 1000, VIEW_H = 320;      // rendered aspect
const ASPECT = VIEW_W / VIEW_H;
// 50m countries and 10m states hold their shape much further in than the old
// 110m silhouette, so the ceiling is city-scale rather than region-scale.
const MIN_Z = 1, MAX_Z = 60;

// One hue family per continent, so the map reads as geography rather than as a
// chart. Natural Earth's MAPCOLOR9 then shifts each country within its family,
// which guarantees no two neighbours land on the same shade.
const FAMILY = [
  { h: 34, s: 27 },   // Africa — ochre
  { h: 58, s: 23 },   // Asia — olive
  { h: 150, s: 23 },  // Europe — green
  { h: 176, s: 23 },  // North America — teal
  { h: 122, s: 25 },  // South America — leaf
  { h: 16, s: 27 },   // Oceania — terracotta
  { h: 205, s: 11 },  // Antarctica — pale slate
];

/** [light-theme fill, dark-theme fill] for one country. */
function landFill(continent: number, mapcolor: number): [string, string] {
  const f = FAMILY[continent] ?? FAMILY[1];
  const i = Math.max(0, Math.min(8, (mapcolor || 1) - 1));
  const h = f.h + ((i % 3) - 1) * 20;
  const l = (((i / 3) | 0) - 1) * 7.5;
  // Dark land sits well above the navy water; light land stays pale enough for
  // dark text to hold contrast on it.
  return [`hsl(${h} ${f.s - 6}% ${72 + l}%)`, `hsl(${h} ${f.s}% ${31 + l}%)`];
}

const placeLabel = (p: Point) =>
  p.city ?? [p.region, p.countryName ?? p.country].filter(Boolean).join(', ');

const ringToPath = (ring: number[]) => {
  let d = '';
  for (let i = 0; i < ring.length; i += 2) {
    d += `${i === 0 ? 'M' : 'L'}${projX(ring[i]).toFixed(3)},${projY(ring[i + 1]).toFixed(3)}`;
  }
  return d + 'Z';
};

// Postal abbreviations only stand in for a name where readers know them; "QR"
// for Quintana Roo teaches nobody anything, so those states wait for the zoom
// that fits their full name.
const ABBREVIATED = new Set(['USA', 'CAN', 'AUS', 'BRA']);

// Past this zoom the coarse outline starts to show its corners, so the detailed
// basemap is worth its bytes — and only from here on.
const DETAIL_Z = 5;

function parseBasemap(geo: { countries?: RawCountry[]; states?: RawState[] }): Basemap {
  return {
    countries: (geo.countries ?? []).map((c) => ({
      name: c.n, short: c.a || null, rank: c.k, at: c.l,
      d: c.r.map(ringToPath).join(''),
      fill: landFill(c.c, c.m),
    })),
    states: (geo.states ?? []).map((s) => ({
      name: s.n, short: s.s, country: s.p, rank: s.k, at: s.l,
      d: s.r.map(ringToPath).join(''),
    })),
  };
}

export function ClientMap({ businessId }: { businessId?: string }) {
  const [coarse, setCoarse] = useState<Basemap | null>(null);
  const [detail, setDetail] = useState<Basemap | null>(null);
  const detailAsked = useRef(false);
  const [selected, setSelected] = useState<Point | null>(null);
  const [hover, setHover] = useState<{ p: Point; x: number; y: number } | null>(null);
  const [size, setSize] = useState({ w: VIEW_W, h: 300 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-map', businessId ?? 'all'],
    queryFn: () => dashboardApi.map(businessId).then((r) => r.data?.data as MapData),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/world-basemap.json')
      .then((r) => r.json())
      .then((geo) => { if (!cancelled) setCoarse(parseBasemap(geo)); })
      .catch(() => setCoarse({ countries: [], states: [] }));
    return () => { cancelled = true; };
  }, []);

  // Label sizes are in CSS pixels, so the layer needs the real box, not the
  // viewBox. Text placed this way is hinted like any other text on the page.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const r = e.contentRect;
      if (r.width > 0 && r.height > 0) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [isLoading, data]);

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
    const z = Math.min(W / (spanX * 3.2), (W / ASPECT) / (spanY * 3.2), 14);
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, zoom: Math.max(MIN_Z, z) };
  }, [points]);

  const [cam, setCam] = useState(home);
  useEffect(() => { setCam(home); }, [home]);

  // Fetched once, on the first zoom that can show the difference. A failure
  // leaves the coarse outline in place, which is a worse map but still a map.
  useEffect(() => {
    if (cam.zoom < DETAIL_Z || detailAsked.current) return;
    detailAsked.current = true;
    fetch('/world-basemap-detail.json')
      .then((r) => r.json())
      .then((geo) => setDetail(parseBasemap(geo)))
      .catch(() => {});
  }, [cam.zoom]);

  const base = detail ?? coarse;

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

  // preserveAspectRatio="slice" scales uniformly by whichever axis overflows and
  // centres the result; world → screen has to match that exactly or the labels
  // drift off their shapes.
  const px = useMemo(() => {
    const k = Math.max(size.w / view.w, size.h / view.h);
    const ox = (size.w - view.w * k) / 2;
    const oy = (size.h - view.h * k) / 2;
    return {
      k,
      x: (wx: number) => ox + (wx - view.x) * k,
      y: (wy: number) => oy + (wy - view.y) * k,
    };
  }, [size, view]);

  // Every name — country, state, city — competes in one greedy pass, largest
  // stake first, and anything that would collide with a name already placed is
  // dropped. Two labels on top of each other are worse than one.
  const labels = useMemo(() => {
    type L = { key: string; text: string; x: number; y: number; size: number; kind: 'city' | 'country' | 'state' };
    const cand: (L & { pri: number })[] = [];
    const near = (x: number, y: number) => x > -60 && x < size.w + 60 && y > -60 && y < size.h + 60;

    for (const p of points) {
      const x = px.x(projX(p.lon)), y = px.y(projY(p.lat));
      if (!near(x, y)) continue;
      cand.push({ key: `p:${p.key}`, text: placeLabel(p), x, y, size: 12, kind: 'city', pri: 0 });
    }
    for (const c of base?.countries ?? []) {
      if (!c.at) continue;
      const x = px.x(projX(c.at[0])), y = px.y(projY(c.at[1]));
      if (!near(x, y)) continue;
      // Rank 2 countries carry the map at world zoom; rank 6 only earn a label
      // once there is room, which is what the collision pass decides.
      const size = c.rank <= 2 ? 12.5 : c.rank <= 3 ? 11.5 : c.rank <= 4 ? 10.5 : 10;
      cand.push({ key: `c:${c.name}`, text: c.name, x, y, size, kind: 'country', pri: 1 + c.rank * 0.1 });
    }
    if (cam.zoom >= 2) {
      for (const s of base?.states ?? []) {
        if (!s.at) continue;
        const x = px.x(projX(s.at[0])), y = px.y(projY(s.at[1]));
        if (!near(x, y)) continue;
        // The abbreviation reads at a zoom where the full name would not fit.
        const abbrev = s.short && ABBREVIATED.has(s.country ?? '');
        if (cam.zoom < 5 && !abbrev) continue;
        const text = cam.zoom >= 5 ? s.name : s.short!;
        cand.push({ key: `s:${s.name}`, text, x, y, size: 9.5, kind: 'state', pri: 2 + s.rank * 0.1 });
      }
    }

    cand.sort((a, b) => a.pri - b.pri || b.size - a.size);
    const kept: L[] = [];
    // The markers are placed before any name is: a label sitting on a dot hides
    // the one thing the map exists to show.
    const boxes = points.flatMap((p) => {
      const x = px.x(projX(p.lon)), y = px.y(projY(p.lat));
      const r = 11;
      return near(x, y) ? [{ x0: x - r, x1: x + r, y0: y - r, y1: y + r }] : [];
    });
    const hits = (b: { x0: number; x1: number; y0: number; y1: number }) =>
      boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);

    for (const c of cand) {
      if (kept.length >= 90) break;
      const w = c.text.length * c.size * 0.56;
      const h = c.size * 1.25;
      // City names sit clear of their marker, above it by preference; everything
      // else starts centred on its shape and, if that slot is taken, shuffles
      // clear of whatever took it — a state pushed off its centre still beats
      // no state at all.
      const slots: [number, number][] = c.kind === 'city'
        ? [[0, -22], [0, 24]]
        : [[0, 0], [0, -h - 4], [0, h + 4], [-w * 0.7, 0], [w * 0.7, 0],
           [0, -2 * h - 6], [0, 2 * h + 6]];
      for (const [dx, dy] of slots) {
        const cx = c.x + dx, cy = c.y + dy;
        const box = { x0: cx - w / 2 - 3, x1: cx + w / 2 + 3, y0: cy - h / 2 - 2, y1: cy + h / 2 + 2 };
        // A name sliced by the edge of the card looks like a rendering fault,
        // so a label has to fit whole or wait for the next pan.
        if (box.x0 < 2 || box.x1 > size.w - 2 || box.y0 < 2 || box.y1 > size.h - 2) continue;
        if (hits(box)) continue;
        boxes.push(box);
        kept.push({ ...c, x: cx, y: cy });
        break;
      }
    }
    return kept;
  }, [base, points, px, size, cam.zoom]);

  // Null means the caller lacks computers:view — render nothing rather than an
  // empty map, which would imply they have no computers.
  if (!isLoading && data === null) return null;

  const scale = view.w / W;                     // world units per rendered unit
  const maxTotal = Math.max(1, ...points.map((p) => p.total));
  const rOf = (n: number) => (4.5 + (Math.sqrt(n) / Math.sqrt(maxTotal)) * 4) * scale;

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
          <div className="h-[300px] flex items-center justify-center text-sm text-muted-foreground">
            Loading map…
          </div>
        ) : points.length === 0 ? (
          <div className="h-[300px] flex flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
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
              className="relative w-full h-[300px] overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700 bg-[#a8cbe6] dark:bg-[#0b1f38] select-none"
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
                {/* Land first, then internal (state) borders, then country
                    borders on top, so the heavier line always wins. */}
                <g>
                  {(base?.countries ?? []).map((c) => (
                    <path
                      key={c.name}
                      d={c.d}
                      fillRule="evenodd"
                      style={{ ['--lf' as string]: c.fill[0], ['--df' as string]: c.fill[1] }}
                      className="fill-[var(--lf)] dark:fill-[var(--df)]"
                    />
                  ))}
                </g>
                <g className="stroke-[#3f5468]/25 dark:stroke-[#8ea7c4]/25" fill="none"
                   strokeWidth={0.6} vectorEffect="non-scaling-stroke">
                  {(base?.states ?? []).map((s) => <path key={s.name} d={s.d} />)}
                </g>
                <g className="stroke-[#26384a]/55 dark:stroke-[#a9c2dd]/50" fill="none"
                   strokeWidth={0.9} vectorEffect="non-scaling-stroke">
                  {(base?.countries ?? []).map((c) => <path key={c.name} d={c.d} />)}
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
                    </g>
                  );
                })}
              </svg>

              {/* Names live in an HTML layer rather than in the SVG: at CSS pixel
                  sizes the browser hints them like body text, so nothing is
                  softened by the viewBox scale. */}
              <div className="pointer-events-none absolute inset-0 overflow-hidden">
                {labels.map((l) => (
                  <span
                    key={l.key}
                    className={
                      'absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap ' +
                      (l.kind === 'city'
                        ? 'font-semibold text-slate-900 dark:text-white'
                        : l.kind === 'country'
                          ? 'font-medium text-slate-800 dark:text-slate-100'
                          : 'text-slate-700 dark:text-slate-300/90')
                    }
                    style={{
                      left: `${l.x}px`,
                      top: `${l.y}px`,
                      fontSize: `${l.size}px`,
                      lineHeight: 1,
                      letterSpacing: l.kind === 'state' ? '0.02em' : undefined,
                      // A halo instead of a background box: names stay readable
                      // over both land and water without covering the geography.
                      textShadow:
                        l.kind === 'city'
                          ? '0 0 3px rgba(2,10,20,.95), 0 1px 2px rgba(2,10,20,.9)'
                          : '0 0 2px rgba(2,10,20,.75), 0 0 4px rgba(2,10,20,.55)',
                    }}
                  >
                    {l.text}
                  </span>
                ))}
              </div>

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
