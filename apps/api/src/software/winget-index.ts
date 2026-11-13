import { inflateRawSync } from 'node:zlib';
import { PACKAGE_ID_MAX, PACKAGE_ID_RE, SOFTWARE_VERSION_RE } from '../actions/catalog';

/**
 * The searchable winget catalog (0.41): the pure half, with no Nest, Prisma,
 * network or process. WingetIndexService fetches and stores; this reads the
 * MSIX, says which rows are kept, and ranks a search. unit-software.mjs
 * calls these directly.
 *
 * The source is the public winget community source's own package index,
 * the file winget itself downloads: an MSIX (a zip) at a fixed URL whose
 * Public/index.db is a SQLite database (schema 2: one `packages` row per
 * package with its latest version). It is about 4 MB. It is read for search
 * only; nothing in it is installed or trusted. An install still reads that
 * version's installer manifest from winget-pkgs and pins its SHA-256, and
 * each computer still hashes what winget downloads before installing.
 */

/** The one URL the index is read from. */
export const WINGET_INDEX_URL = 'https://cdn.winget.microsoft.com/cache/source2.msix';
/** What a read may take: the MSIX, the database inside it, the rows out of sqlite3. */
export const INDEX_MAX_MSIX_BYTES = 32 * 1024 * 1024;
export const INDEX_MAX_DB_BYTES = 128 * 1024 * 1024;
export const INDEX_MAX_ROWS = 50_000;
export const INDEX_FETCH_TIMEOUT_MS = 60_000;
/** A successful read is kept this long before the sweep reads it again; a failed one is retried after the backoff. */
export const INDEX_REFRESH_HOURS = 24;
export const INDEX_RETRY_MINUTES = 60;
/** The database entry inside the MSIX. */
export const INDEX_DB_ENTRY = 'Public/index.db';

/**
 * WINGET_INDEX_URL replaces the URL only with a loopback http URL (the
 * end-to-end test's fixture server), as WINGET_MANIFEST_BASE does for
 * manifests. Anything else is ignored.
 */
export function indexUrl(env: Record<string, string | undefined> = process.env): string {
  const o = env.WINGET_INDEX_URL;
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, one optional group with no nested quantifier over the same characters; read once from the environment
  if (o && /^http:\/\/127\.0\.0\.1:[0-9]{2,5}(\/[A-Za-z0-9._/-]*)?$/.test(o)) return o;
  return WINGET_INDEX_URL;
}

/** WINGET_INDEX_SWEEP=off: this process never reads the index by itself (a Platform Admin can still ask). */
export const indexSweepEnabled = (env: Record<string, string | undefined> = process.env) => env.WINGET_INDEX_SWEEP !== 'off';

/** Is a refresh due? Successful reads at most daily; failures retried after the backoff. */
export function refreshDue(s: { refreshedAt: Date | null; attemptedAt: Date | null } | null, now: Date): boolean {
  if (!s) return true;
  if (s.attemptedAt && now.getTime() - s.attemptedAt.getTime() < INDEX_RETRY_MINUTES * 60_000) return false;
  return !s.refreshedAt || now.getTime() - s.refreshedAt.getTime() >= INDEX_REFRESH_HOURS * 3_600_000;
}

// ── The MSIX (a zip) ────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export class ZipError extends Error {}

/**
 * One file out of a zip, by its exact name, from the central directory (the
 * local headers of an MSIX carry a data descriptor, so their sizes are 0).
 * Stored or deflated only; the output is capped and its CRC-32 checked. No
 * ZIP64, no encryption, no other entry is read.
 */
export function readZipEntry(zip: Buffer, name: string, maxOut: number): Buffer {
  const min = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('not a zip file (no end of central directory)');
  const entries = zip.readUInt16LE(eocd + 10), cdSize = zip.readUInt32LE(eocd + 12), cdOff = zip.readUInt32LE(eocd + 16);
  if (cdOff === 0xffffffff || entries === 0xffff) throw new ZipError('ZIP64 is not read');
  if (cdOff + cdSize > eocd) throw new ZipError('central directory out of bounds');
  let p = cdOff;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== 0x02014b50) throw new ZipError('bad central directory entry');
    const flags = zip.readUInt16LE(p + 8), method = zip.readUInt16LE(p + 10), crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28), xlen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32), local = zip.readUInt32LE(p + 42);
    const fname = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (fname !== name) continue;
    if (flags & 1) throw new ZipError('encrypted entry');
    if (usize > maxOut) throw new ZipError(`${name} is larger than ${maxOut} bytes`);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new ZipError('bad local header');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + csize > zip.length) throw new ZipError('entry out of bounds');
    const raw = zip.subarray(start, start + csize);
    let out: Buffer;
    if (method === 0) out = Buffer.from(raw);
    else if (method === 8) {
      try { out = inflateRawSync(raw, { maxOutputLength: maxOut }); } catch (e) { throw new ZipError(`could not inflate ${name}: ${(e as Error).message}`); }
    } else throw new ZipError(`compression method ${method} is not read`);
    if (out.length !== usize) throw new ZipError(`${name} inflated to ${out.length} bytes, expected ${usize}`);
    if (crc32(out) !== crc) throw new ZipError(`${name} failed its CRC-32 check`);
    return out;
  }
  throw new ZipError(`${name} is not in the archive`);
}

// ── The SQLite index ────────────────────────────────────────────────────────

/** Schema 2 of the winget source index: what the rows are read from. */
export const INDEX_SCHEMA_SQL = "SELECT name, value FROM metadata WHERE name IN ('majorVersion', 'minorVersion', 'lastwritetime');";
export const INDEX_ROWS_SQL =
  'SELECT p.id AS id, p.name AS name, p.moniker AS moniker, p.latest_version AS version, '
  + '(SELECT n.norm_publisher FROM norm_publishers2 n WHERE n.package = p.rowid ORDER BY n.norm_publisher LIMIT 1) AS publisher '
  + 'FROM packages p ORDER BY p.id LIMIT 50001;';

export interface IndexRow { packageId: string; name: string; publisher: string | null; moniker: string | null; latestVersion: string }

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CTRL = /[\u0000-\u001f\u007f<>]/g;
const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.replace(CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
};

/**
 * The rows kept from sqlite3's JSON output: an id that could be a plan's
 * packageId, and bounded, inert text. A row whose id fails the charset is
 * skipped (and counted); one whose latest version is not one the agent
 * accepts is kept, and offered as not installable.
 */
export function normalizeIndexRows(raw: unknown): { rows: IndexRow[]; skipped: number } {
  if (!Array.isArray(raw)) throw new Error('the index query did not return rows');
  if (raw.length > INDEX_MAX_ROWS) throw new Error(`the index has more than ${INDEX_MAX_ROWS} packages`);
  const rows: IndexRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of raw as Record<string, unknown>[]) {
    const id = typeof r?.id === 'string' ? r.id : '';
    const version = clean(r?.version, 64);
    if (!id || id.length > PACKAGE_ID_MAX || !PACKAGE_ID_RE.test(id) || !version || seen.has(id.toLowerCase())) { skipped++; continue; }
    seen.add(id.toLowerCase());
    rows.push({ packageId: id, name: clean(r.name, 200) ?? id, publisher: clean(r.publisher, 120), moniker: clean(r.moniker, 64), latestVersion: version });
  }
  return { rows, skipped };
}

export function checkIndexSchema(raw: unknown): { writtenAt: Date | null } {
  const m = new Map((Array.isArray(raw) ? raw : []).map((r: { name?: unknown; value?: unknown }) => [String(r?.name), String(r?.value)]));
  if (m.get('majorVersion') !== '2') throw new Error(`the index is schema ${m.get('majorVersion') ?? 'unknown'}, not 2`);
  const t = Number(m.get('lastwritetime'));
  return { writtenAt: Number.isFinite(t) && t > 1_500_000_000 && t < 4_000_000_000 ? new Date(t * 1000) : null };
}

// ── Search ──────────────────────────────────────────────────────────────────

/** A search: letters, digits, spaces and . + _ - (2 to 64 characters). */
export const SEARCH_RE = /^[A-Za-z0-9][A-Za-z0-9 .+_-]{1,63}$/;
export const SEARCH_LIMIT = 25;

export const installable = (r: Pick<IndexRow, 'latestVersion'>) => SOFTWARE_VERSION_RE.test(r.latestVersion);

/**
 * Rank candidate rows for a query: an exact id, then the id or moniker, then
 * the name, then the publisher; earlier and shorter matches first; ties by id.
 */
export function rankSearch(q: string, rows: IndexRow[], limit = SEARCH_LIMIT): IndexRow[] {
  const s = q.trim().toLowerCase();
  const terms = s.split(/\s+/).filter(Boolean);
  const score = (r: IndexRow): number => {
    const id = r.packageId.toLowerCase(), name = r.name.toLowerCase(), mon = (r.moniker ?? '').toLowerCase(), pub = (r.publisher ?? '').toLowerCase();
    const hay = `${id} ${name} ${mon} ${pub}`;
    if (!terms.every((t) => hay.includes(t))) return -1;
    if (id === s || mon === s) return 1000;
    if (name === s) return 900;
    let v = 0;
    if (id.startsWith(s) || id.split('.').some((seg) => seg.startsWith(s))) v = Math.max(v, 700);
    if (name.startsWith(s)) v = Math.max(v, 650);
    if (mon.startsWith(s)) v = Math.max(v, 600);
    if (name.includes(s)) v = Math.max(v, 500);
    if (id.includes(s)) v = Math.max(v, 450);
    if (pub.includes(s.replace(/[^a-z0-9]/g, ''))) v = Math.max(v, 300);
    return Math.max(v, 100) - Math.min(99, name.length / 4);
  };
  return rows.map((r) => ({ r, v: score(r) })).filter((x) => x.v >= 0)
    .sort((a, b) => b.v - a.v || a.r.packageId.localeCompare(b.r.packageId)).slice(0, limit).map((x) => x.r);
}
