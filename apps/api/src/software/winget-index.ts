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
/**
 * When the sweep will next read the index (0.42), so an empty catalog says
 * when it fills: the later of the hour after the last attempt and a day after
 * the last success (or now, never read). The sweep looks every 15 minutes, so
 * this is the earliest, not the exact time. null when the sweep is off.
 */
export const INDEX_TICK_MINUTES = 15;
export function nextIndexRead(s: { refreshedAt: Date | null; attemptedAt: Date | null } | null, now: Date, sweepOn: boolean): Date | null {
  if (!sweepOn) return null;
  const retry = s?.attemptedAt ? s.attemptedAt.getTime() + INDEX_RETRY_MINUTES * 60_000 : 0;
  const due = s?.refreshedAt ? s.refreshedAt.getTime() + INDEX_REFRESH_HOURS * 3_600_000 : 0;
  return new Date(Math.max(retry, due, now.getTime()));
}

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
 * encryption, no other entry is read.
 *
 * 0.41.1: ZIP64 is read. MSIX packagers write the ZIP64 end records whatever
 * the archive's size, so the real source2.msix (4 MB) was refused with
 * "ZIP64 is not read" on its first production read. Every 64-bit value is
 * bounds-checked against the buffer before use, so it cannot point outside.
 */
/** A little-endian u64 that must fit a safe integer (no archive here is near 2^53 bytes). */
function u64(b: Buffer, at: number): number {
  if (at < 0 || at + 8 > b.length) throw new ZipError('ZIP64 field out of bounds');
  const v = b.readBigUInt64LE(at);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('ZIP64 value out of range');
  return Number(v);
}

export function readZipEntry(zip: Buffer, name: string, maxOut: number): Buffer {
  const min = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipError('not a zip file (no end of central directory)');
  let entries = zip.readUInt16LE(eocd + 10), cdSize = zip.readUInt32LE(eocd + 12), cdOff = zip.readUInt32LE(eocd + 16);
  let cdEnd = eocd;
  if (cdOff === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
    // The ZIP64 end-of-central-directory locator sits just before the classic record.
    const loc = eocd - 20;
    if (loc < 0 || zip.readUInt32LE(loc) !== 0x07064b50) throw new ZipError('ZIP64 locator missing');
    const z = u64(zip, loc + 8);
    if (z + 56 > loc || zip.readUInt32LE(z) !== 0x06064b50) throw new ZipError('bad ZIP64 end of central directory');
    entries = u64(zip, z + 32); cdSize = u64(zip, z + 40); cdOff = u64(zip, z + 48);
    cdEnd = z;
  }
  if (cdOff + cdSize > cdEnd) throw new ZipError('central directory out of bounds');
  let p = cdOff;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > cdEnd || zip.readUInt32LE(p) !== 0x02014b50) throw new ZipError('bad central directory entry');
    const flags = zip.readUInt16LE(p + 8), method = zip.readUInt16LE(p + 10), crc = zip.readUInt32LE(p + 16);
    let csize = zip.readUInt32LE(p + 20), usize = zip.readUInt32LE(p + 24);
    const nlen = zip.readUInt16LE(p + 28), xlen = zip.readUInt16LE(p + 30), clen = zip.readUInt16LE(p + 32);
    let local = zip.readUInt32LE(p + 42);
    if (p + 46 + nlen + xlen + clen > cdEnd) throw new ZipError('bad central directory entry');
    const fname = zip.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (usize === 0xffffffff || csize === 0xffffffff || local === 0xffffffff) {
      // The ZIP64 extra field (id 1) holds, in order, only the values set to 0xffffffff.
      const extra = zip.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
      let found = false;
      for (let q = 0; q + 4 <= extra.length;) {
        const id = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2);
        if (q + 4 + len > extra.length) break;
        if (id === 1) {
          let r = q + 4;
          const next = () => { if (r + 8 > q + 4 + len) throw new ZipError('short ZIP64 extra field'); const v = u64(extra, r); r += 8; return v; };
          if (usize === 0xffffffff) usize = next();
          if (csize === 0xffffffff) csize = next();
          if (local === 0xffffffff) local = next();
          found = true; break;
        }
        q += 4 + len;
      }
      if (!found) throw new ZipError('ZIP64 extra field missing');
    }
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
 * Rank candidate rows for a query (0.42). Tiers, best first:
 *   1. an exact name, moniker or id;
 *   2. a name that starts with the query as a whole word ("Notepad++" for
 *      "notepad", not "Notepad2");
 *   3. the query as a whole word anywhere in the name ("Windows Notepad"),
 *      or a moniker that starts with it as a word;
 *   4. a name that starts with the query at all ("Notepad2");
 *   5. an id segment or moniker that starts with it;
 *   6. the query anywhere in the name, then the id, then the publisher.
 * Every term must appear somewhere. Ties: the shorter name, then the id.
 * 0.41 ranked an id-segment prefix above a whole-word name, so "notepad"
 * put Notepad2, NotepadsApp and Notepad3 ahead of Notepad++ (sixth).
 */
export function rankSearch(q: string, rows: IndexRow[], limit = SEARCH_LIMIT): IndexRow[] {
  const s = q.trim().toLowerCase().replace(/\s+/g, ' ');
  const terms = s.split(' ').filter(Boolean);
  // A word boundary is anything that is not a letter or a digit ("+" counts as a boundary: "notepad" is a word of "notepad++").
  // Plain string scans, so nothing built from the query reaches a RegExp.
  const alnum = (c: string | undefined) => c !== undefined && /[a-z0-9]/.test(c);
  const wordAt = (h: string, i: number) => !alnum(h[i - 1]) && !alnum(h[i + s.length]);
  const startsWord = { test: (h: string) => h.startsWith(s) && wordAt(h, 0) };
  const word = { test: (h: string) => { for (let i = h.indexOf(s); i >= 0; i = h.indexOf(s, i + 1)) if (wordAt(h, i)) return true; return false; } };
  const tier = (r: IndexRow): number => {
    const id = r.packageId.toLowerCase(), name = r.name.toLowerCase(), mon = (r.moniker ?? '').toLowerCase(), pub = (r.publisher ?? '').toLowerCase();
    if (!terms.every((t) => `${id} ${name} ${mon} ${pub}`.includes(t))) return -1;
    if (name === s || mon === s || id === s) return 1;
    if (startsWord.test(name)) return 2;
    if (word.test(name) || startsWord.test(mon)) return 3;
    if (name.startsWith(s)) return 4;
    if (id.split('.').some((seg) => seg.startsWith(s)) || mon.startsWith(s)) return 5;
    if (name.includes(s)) return 6;
    if (id.includes(s)) return 7;
    if (pub.includes(s.replace(/[^a-z0-9]/g, ''))) return 8;
    return 9;
  };
  return rows.map((r) => ({ r, t: tier(r) })).filter((x) => x.t > 0)
    .sort((a, b) => a.t - b.t || a.r.name.length - b.r.name.length || a.r.packageId.localeCompare(b.r.packageId)).slice(0, limit).map((x) => x.r);
}
