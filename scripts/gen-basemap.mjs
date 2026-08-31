#!/usr/bin/env node
/**
 * Regenerates apps/web/public/world-basemap.json from Natural Earth.
 *
 * The dashboard map is a plain equirectangular SVG with no tile server, so the
 * basemap has to carry everything the map needs to draw and label itself:
 * geometry, a name, a label anchor and enough classification to colour the land
 * by region without a lookup table in the component.
 *
 * Two files come out of it. The dashboard paints the coarse one immediately and
 * only fetches the detailed one once someone zooms past the point where the
 * simplified coastline starts to show its corners — a first paint that costs a
 * tenth of the bytes, and no loss of fidelity where fidelity is visible.
 *
 * Sources (Natural Earth, public domain):
 *   ne_50m_admin_0_countries                 — country outlines, names, labels
 *   ne_10m_admin_1_states_provinces_lakes    — states/provinces for big countries
 *
 * Run: node scripts/gen-basemap.mjs
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'apps/web/public/world-basemap.json');
const OUT_DETAIL = join(ROOT, 'apps/web/public/world-basemap-detail.json');
const CACHE = join(ROOT, 'node_modules/.cache/natural-earth');
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

// Admin-1 is only worth its bytes where the divisions are big enough to read.
const ADMIN1 = new Set([
  'United States of America', 'Canada', 'Mexico', 'Brazil', 'Australia',
  'China', 'India', 'Russia', 'Argentina', 'Kazakhstan', 'Indonesia',
  'Saudi Arabia', 'South Africa',
]);

// Continent index, used by the component to pick a land palette.
const CONTINENT = ['Africa', 'Asia', 'Europe', 'North America', 'South America', 'Oceania', 'Antarctica'];

async function fetchNE(name) {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${name}.geojson`);
  if (!existsSync(path)) {
    process.stderr.write(`fetching ${name}…\n`);
    const res = await fetch(`${NE}/${name}.geojson`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Ramer–Douglas–Peucker on lon/lat degrees. */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, best = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      const d = len2 === 0
        ? Math.hypot(px - ax, py - ay)
        : Math.abs(dy * px - dx * py + bx * ay - by * ax) / Math.sqrt(len2);
      if (d > best) { best = d; far = i; }
    }
    if (far > 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Three decimals is ~100 m at the equator: still smooth at the deepest zoom the
// map allows, and the extra digit costs less than it looks once gzipped.
const round = (pts) => pts.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]);

/** Flatten a GeoJSON geometry to rings, dropping slivers and over-detailing. */
function rings(geom, { tol, minArea }) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates]
    : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const out = [];
  let biggest = null, biggestA = -Infinity;
  for (const poly of polys) {
    for (const ring of poly) {                     // holes included: lakes read as water
      const s = round(simplify(ring, tol));
      if (s.length < 4) continue;
      const a = Math.abs(area(s));
      if (a > biggestA) { biggestA = a; biggest = s.flat(); }
      if (a < minArea) continue;                   // sliver islands are noise at any zoom
      out.push(s.flat());
    }
  }
  // A country smaller than the sliver threshold — Malta, Singapore — still has
  // to be on the map, or it can never be labelled.
  if (!out.length && biggest) out.push(biggest);
  return out;
}

function area(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

/** Largest-ring centroid — a usable label anchor when Natural Earth has none. */
function anchor(flatRings) {
  let best = null, bestA = -Infinity;
  for (const flat of flatRings) {
    const ring = [];
    for (let i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
    const a = Math.abs(area(ring));
    if (a > bestA) { bestA = a; best = ring; }
  }
  if (!best) return null;
  let x = 0, y = 0;
  for (const [px, py] of best) { x += px; y += py; }
  return [+(x / best.length).toFixed(2), +(y / best.length).toFixed(2)];
}

const rawCountries = (await fetchNE('ne_50m_admin_0_countries')).features;
const rawStates = (await fetchNE('ne_10m_admin_1_states_provinces_lakes')).features;

/**
 * @param {number} tolC country simplification tolerance, degrees
 * @param {number} tolS state simplification tolerance, degrees
 */
function build(tolC, tolS) {
const countries = [];
for (const f of rawCountries) {
  const p = f.properties;
  if (!(p.NAME_EN || p.NAME)) continue;          // nothing to label it with
  const r = rings(f.geometry, { tol: tolC, minArea: 0.03 });
  if (!r.length) continue;
  const label = Number.isFinite(p.LABEL_X) && Number.isFinite(p.LABEL_Y)
    ? [+p.LABEL_X.toFixed(2), +p.LABEL_Y.toFixed(2)]
    : anchor(r);
  countries.push({
    n: p.NAME_EN || p.NAME,
    a: p.ISO_A2_EH && p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : (p.POSTAL || ''),
    c: Math.max(0, CONTINENT.indexOf(p.CONTINENT)),   // land palette family
    m: p.MAPCOLOR9 ?? 1,                              // neighbours never share a shade
    k: p.LABELRANK ?? 6,                              // smaller = label sooner
    l: label,
    r,
  });
}

const states = [];
for (const f of rawStates) {
  const p = f.properties;
  if (!ADMIN1.has(p.admin)) continue;
  if (p.type_en === 'Water body' || !p.name) continue;
  const r = rings(f.geometry, { tol: tolS, minArea: 0.03 });
  if (!r.length) continue;
  const label = Number.isFinite(p.longitude) && Number.isFinite(p.latitude)
    ? [+p.longitude.toFixed(2), +p.latitude.toFixed(2)]
    : anchor(r);
  states.push({
    n: p.name,
    // Postal code where there is one — "FL" survives a zoom level that "Florida" does not.
    s: p.postal && p.postal.length <= 3 ? p.postal : null,
    p: p.adm0_a3,
    k: p.labelrank ?? 5,
    l: label,
    r,
  });
}

countries.sort((a, b) => a.k - b.k);
states.sort((a, b) => a.k - b.k);
return { v: 2, continents: CONTINENT, countries, states };
}

// 0.06° is about a pixel at the zoom where the detail file takes over. State
// borders only appear part-way in and are drawn hairline, so the first file can
// carry them far coarser than its coastlines.
for (const [file, tolC, tolS] of [[OUT, 0.06, 0.15], [OUT_DETAIL, 0.015, 0.015]]) {
  const geo = build(tolC, tolS);
  writeFileSync(file, JSON.stringify(geo));
  const kb = (readFileSync(file).length / 1024).toFixed(0);
  process.stderr.write(`wrote ${file} — ${geo.countries.length} countries, ${geo.states.length} states, ${kb} KB\n`);
}
