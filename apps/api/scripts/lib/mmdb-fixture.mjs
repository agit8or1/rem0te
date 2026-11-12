/**
 * A tiny MaxMind DB (.mmdb) writer for tests (0.36).
 *
 * The dashboard map places computers with GeoipService, which reads a
 * DB-IP City database through the `maxmind` package. The test stacks have no
 * such database — and must not read the production one — so before 0.36 no
 * suite could prove a single marker. This writes a real file in the format
 * the reader expects, holding only the networks a suite gives it, so the API
 * under test resolves those addresses through its unchanged lookup code.
 *
 * Format: MaxMind DB 2.0 (https://maxmind.github.io/MaxMind-DB/). An IPv4
 * search tree with 24-bit records, the 16-byte data-section separator, the
 * data section, then the metadata marker and map. Only the types a City
 * record and the metadata need are encoded: maps, arrays, UTF-8 strings,
 * doubles and unsigned integers. No pointers, so every record is written in
 * full; that is legal and keeps the writer short.
 *
 * Use documentation-range networks (192.0.2.0/24, 198.51.100.0/24,
 * 203.0.113.0/24, RFC 5737): GeoipService does not treat them as private, and
 * no real host is ever named.
 *
 *   writeCityMmdb(file, [{ cidr: '198.51.100.0/24', city: 'Silent Town', region: 'Fixture',
 *                          country: 'US', countryName: 'United States', lat: 39.7, lon: -105 }])
 */
import { writeFileSync } from 'fs';

const ctrl = (type, size) => {
  // Types 1–7 live in the control byte; 8+ are "extended" (type bits 0, then a byte of type − 7).
  const head = [];
  let sizeBits, extra = [];
  if (size < 29) sizeBits = size;
  else if (size < 29 + 256) { sizeBits = 29; extra = [size - 29]; }
  else if (size < 285 + 65536) { sizeBits = 30; const v = size - 285; extra = [v >> 8, v & 0xff]; }
  else { sizeBits = 31; const v = size - 65821; extra = [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]; }
  if (type <= 7) head.push((type << 5) | sizeBits);
  else head.push(sizeBits, type - 7);
  return Buffer.from([...head, ...extra]);
};

const uintBytes = (n) => {
  let v = BigInt(n); const out = [];
  while (v > 0n) { out.unshift(Number(v & 0xffn)); v >>= 8n; }
  return Buffer.from(out);
};

/** Encode a JS value. Numbers are doubles unless wrapped as { $uint16 | $uint32 | $uint64: n }. */
function encode(v) {
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([ctrl(2, b.length), b]); }
  if (typeof v === 'number') { const b = Buffer.alloc(8); b.writeDoubleBE(v); return Buffer.concat([ctrl(3, 8), b]); }
  if (Array.isArray(v)) return Buffer.concat([ctrl(11, v.length), ...v.map(encode)]);
  if (v && typeof v === 'object') {
    for (const [k, type] of [['$uint16', 5], ['$uint32', 6], ['$uint64', 9]]) {
      if (k in v) { const b = uintBytes(v[k]); return Buffer.concat([ctrl(type, b.length), b]); }
    }
    const keys = Object.keys(v);
    return Buffer.concat([ctrl(7, keys.length), ...keys.flatMap((k) => [encode(k), encode(v[k])])]);
  }
  throw new Error(`mmdb-fixture: cannot encode ${typeof v}`);
}

const ipv4Bits = (ip) => {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new Error(`mmdb-fixture: not an IPv4 address: ${ip}`);
  return parts.reduce((acc, p) => (acc << 8) | p, 0) >>> 0;
};

/**
 * Write an IPv4 City database holding `entries` and return the file path.
 * Each entry: { cidr, city, region?, regionCode?, country, countryName?, lat, lon }.
 */
export function writeCityMmdb(file, entries) {
  // The trie: node 0 is the root; each node has [left, right] children that
  // are either another node index, { data: i } or null (no data).
  const nodes = [[null, null]];
  for (const [i, e] of entries.entries()) {
    const [ip, lenStr] = e.cidr.split('/');
    const len = Number(lenStr);
    if (!Number.isInteger(len) || len < 1 || len > 32) throw new Error(`mmdb-fixture: bad prefix length in ${e.cidr}`);
    const bits = ipv4Bits(ip);
    let n = 0;
    for (let d = 0; d < len; d++) {
      const bit = (bits >>> (31 - d)) & 1;
      if (d === len - 1) {
        if (nodes[n][bit] !== null) throw new Error(`mmdb-fixture: ${e.cidr} overlaps another entry`);
        nodes[n][bit] = { data: i }; break;
      }
      let next = nodes[n][bit];
      if (next === null) { next = nodes.length; nodes.push([null, null]); nodes[n][bit] = next; }
      else if (typeof next !== 'number') throw new Error(`mmdb-fixture: ${e.cidr} overlaps a shorter prefix`);
      n = next;
    }
  }
  const nodeCount = nodes.length;

  // Data section: one full City record per entry.
  const records = entries.map((e) => encode({
    city: { names: { en: e.city } },
    country: { iso_code: e.country, names: { en: e.countryName ?? e.country } },
    location: { latitude: e.lat, longitude: e.lon, accuracy_radius: { $uint16: 20 } },
    ...(e.region ? { subdivisions: [{ iso_code: e.regionCode ?? e.region.slice(0, 2).toUpperCase(), names: { en: e.region } }] } : {}),
  }));
  const offsets = []; let off = 0;
  for (const r of records) { offsets.push(off); off += r.length; }
  const data = Buffer.concat(records);

  // Records: a node index, nodeCount for "no data", or nodeCount + 16 + data offset.
  const value = (c) => (c === null ? nodeCount : typeof c === 'number' ? c : nodeCount + 16 + offsets[c.data]);
  if (nodeCount + 16 + data.length >= 2 ** 24) throw new Error('mmdb-fixture: too large for 24-bit records');
  const tree = Buffer.alloc(nodeCount * 6);
  nodes.forEach(([l, r], i) => { tree.writeUIntBE(value(l), i * 6, 3); tree.writeUIntBE(value(r), i * 6 + 3, 3); });

  const metadata = encode({
    node_count: { $uint32: nodeCount },
    record_size: { $uint16: 24 },
    ip_version: { $uint16: 4 },
    database_type: 'DBIP-City-Lite',
    languages: ['en'],
    binary_format_major_version: { $uint16: 2 },
    binary_format_minor_version: { $uint16: 0 },
    build_epoch: { $uint64: Math.floor(Date.now() / 1000) },
    description: { en: 'rem0te test fixture: documentation-range networks only' },
  });
  const marker = Buffer.concat([Buffer.from([0xab, 0xcd, 0xef]), Buffer.from('MaxMind.com', 'ascii')]);
  writeFileSync(file, Buffer.concat([tree, Buffer.alloc(16), data, marker, metadata]));
  return file;
}
