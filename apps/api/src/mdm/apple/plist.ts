/**
 * XML property lists, strictly (0.84 Harbor, docs/own-mdm.md M2, §93).
 *
 * Pure: this file imports nothing and reads no clock. Apple devices send
 * check-in and command-result messages as XML plists; Rem0te answers with
 * commands and profiles in the same form. This is the one parser and the one
 * writer for them.
 *
 * The parser is deliberately small and refuses rather than guesses:
 *   - XML plists only (a binary plist, `bplist00…`, is refused);
 *   - the elements Apple's format defines and nothing else: dict, array,
 *     string, integer, real, true, false, date, data, key;
 *   - no entities but the five XML ones and numeric character references,
 *     no CDATA, no processing instructions after the declaration, no DTD
 *     but the standard DOCTYPE line (never fetched), no attributes but the
 *     root's version — so there is nothing to expand and nothing to fetch;
 *   - bounded depth, element count and string length; a duplicate key in one
 *     dict is refused.
 *
 * It is called only AFTER a device message's signature has been checked
 * (apple-mdm.service.ts): an unsigned body is never parsed.
 */

export type PlistValue = string | number | bigint | boolean | Date | Uint8Array | PlistValue[] | { [k: string]: PlistValue };
export type PlistDict = { [k: string]: PlistValue };

export class PlistError extends Error {
  constructor(message: string) { super(message); this.name = 'PlistError'; }
}

export const PLIST_MAX_DEPTH = 24;
export const PLIST_MAX_NODES = 200_000;
export const PLIST_MAX_STRING = 1_000_000;

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeText(s: string): string {
  if (s.length > PLIST_MAX_STRING) throw new PlistError('string too long');
  if (/&(?!#x[0-9A-Fa-f]{1,6};|#[0-9]{1,7};|[a-z]{2,4};)/.test(s)) throw new PlistError('bare ampersand');
  return s.replace(/&(#x[0-9A-Fa-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (_m, e: string) => {
    const cp = e.startsWith('#x') ? Number.parseInt(e.slice(2), 16) : e.startsWith('#') ? Number.parseInt(e.slice(1), 10) : -1;
    if (cp >= 0) {
      if (cp > 0x10ffff || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13)) throw new PlistError('bad character reference');
      return String.fromCodePoint(cp);
    }
    const v = ENTITY[e];
    if (v === undefined) throw new PlistError('unknown entity');
    return v;
  });
}

interface Tok { kind: 'open' | 'close' | 'empty' | 'text'; name: string; text: string }

/** Tokenise the body between the root's <plist> tags. */
function* tokens(xml: string): Generator<Tok> {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) { yield { kind: 'text', name: '', text: xml.slice(i) }; return; }
    if (lt > i) yield { kind: 'text', name: '', text: xml.slice(i, lt) };
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) throw new PlistError('unterminated comment');
      i = end + 3;
      continue;
    }
    const gt = xml.indexOf('>', lt);
    if (gt < 0) throw new PlistError('unterminated tag');
    const raw = xml.slice(lt + 1, gt);
    const m = /^(\/?)([a-z]+)\s*(\/?)$/.exec(raw);
    if (!m) throw new PlistError('unexpected markup');
    if (m[1] && m[3]) throw new PlistError('bad tag');
    yield { kind: m[1] ? 'close' : m[3] ? 'empty' : 'open', name: m[2], text: '' };
    i = gt + 1;
  }
}

const SCALARS = new Set(['string', 'integer', 'real', 'date', 'data', 'key']);

/** Parse an XML plist whose root is a dict. Throws PlistError on anything else. */
export function parsePlist(input: Uint8Array | string): PlistDict {
  const v = parsePlistValue(input);
  if (!isDict(v)) throw new PlistError('the root is not a dict');
  return v;
}

export function parsePlistValue(input: Uint8Array | string): PlistValue {
  let xml = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
  if (xml.startsWith('bplist')) throw new PlistError('binary plists are not accepted');
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  // The declaration and the standard DOCTYPE line are the only prologue allowed.
  xml = xml.replace(/^\s*<\?xml version="1\.0" encoding="(?:UTF-8|utf-8)"\s*\?>/, '');
  xml = xml.replace(/^\s*<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">/, '');
  const open = /^\s*<plist(?: version="1\.0")?>/.exec(xml);
  if (!open) throw new PlistError('not a plist');
  const close = xml.lastIndexOf('</plist>');
  if (close < 0 || xml.slice(close + 8).trim() !== '') throw new PlistError('not a plist');
  const body = xml.slice(open[0].length, close);
  if (/<!\[CDATA\[|<\?|<!DOCTYPE|<!ENTITY/.test(body)) throw new PlistError('unexpected markup');

  let nodes = 0;
  const it = tokens(body);
  let peeked: Tok | null = null;
  const next = (): Tok | null => { if (peeked) { const p = peeked; peeked = null; return p; } const r = it.next(); return r.done ? null : r.value; };
  const nextTag = (): Tok | null => {
    for (;;) {
      const t = next();
      if (!t) return null;
      if (t.kind === 'text') { if (t.text.trim() !== '') throw new PlistError('text outside an element'); continue; }
      return t;
    }
  };

  const value = (t: Tok, depth: number): PlistValue => {
    if (depth > PLIST_MAX_DEPTH) throw new PlistError('too deep');
    if (++nodes > PLIST_MAX_NODES) throw new PlistError('too many elements');
    if (t.kind === 'close') throw new PlistError('unexpected close');
    if (t.kind === 'empty') {
      switch (t.name) {
        case 'true': return true;
        case 'false': return false;
        case 'dict': return {};
        case 'array': return [];
        case 'string': return '';
        case 'data': return new Uint8Array(0);
        default: throw new PlistError(`empty <${t.name}/>`);
      }
    }
    if (t.name === 'true' || t.name === 'false') {
      const c = nextTag();
      if (!c || c.kind !== 'close' || c.name !== t.name) throw new PlistError('bad boolean');
      return t.name === 'true';
    }
    if (SCALARS.has(t.name)) {
      let text = '';
      for (;;) {
        const c = next();
        if (!c) throw new PlistError('unterminated element');
        if (c.kind === 'text') { text += c.text; if (text.length > PLIST_MAX_STRING * 2) throw new PlistError('string too long'); continue; }
        if (c.kind === 'close' && c.name === t.name) break;
        throw new PlistError('markup inside a scalar');
      }
      return scalar(t.name, text);
    }
    if (t.name === 'array') {
      const out: PlistValue[] = [];
      for (;;) {
        const c = nextTag();
        if (!c) throw new PlistError('unterminated array');
        if (c.kind === 'close' && c.name === 'array') return out;
        out.push(value(c, depth + 1));
      }
    }
    if (t.name === 'dict') {
      const out: PlistDict = Object.create(null) as PlistDict;
      for (;;) {
        const k = nextTag();
        if (!k) throw new PlistError('unterminated dict');
        if (k.kind === 'close' && k.name === 'dict') return out;
        if (k.name !== 'key') throw new PlistError('a dict entry without a key');
        const key = value(k, depth + 1) as string;
        if (Object.prototype.hasOwnProperty.call(out, key)) throw new PlistError('duplicate key');
        const v = nextTag();
        if (!v) throw new PlistError('a key without a value');
        if (v.name === 'key') throw new PlistError('a key without a value');
        out[key] = value(v, depth + 1);
      }
    }
    throw new PlistError(`unknown element <${t.name}>`);
  };

  const first = nextTag();
  if (!first) throw new PlistError('empty plist');
  const out = value(first, 0);
  if (nextTag()) throw new PlistError('more than one root value');
  return out;
}

function scalar(name: string, raw: string): PlistValue {
  switch (name) {
    case 'string':
    case 'key':
      return decodeText(raw);
    case 'integer': {
      const s = raw.trim();
      if (!/^-?[0-9]{1,20}$/.test(s)) throw new PlistError('bad integer');
      const n = Number(s);
      return Number.isSafeInteger(n) ? n : BigInt(s);
    }
    case 'real': {
      const s = raw.trim();
      if (s.length > 64) throw new PlistError('bad real');
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored, at most 64 characters, each group starts with a distinct literal
      if (!/^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(s)) throw new PlistError('bad real');
      return Number(s);
    }
    case 'date': {
      const s = raw.trim();
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(s)) throw new PlistError('bad date');
      return new Date(s);
    }
    case 'data': {
      const s = raw.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new PlistError('bad data');
      return new Uint8Array(Buffer.from(s, 'base64'));
    }
  }
  throw new PlistError('unknown scalar');
}

export const isDict = (v: unknown): v is PlistDict =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);

// ── Writing ────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Control characters other than tab and newline are not valid XML 1.0: refuse to write them.
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

function write(v: PlistValue, ind: string, out: string[]) {
  if (typeof v === 'string') {
    if (XML_INVALID.test(v)) throw new PlistError('a string with control characters');
    out.push(`${ind}<string>${esc(v)}</string>`);
  } else if (typeof v === 'boolean') out.push(`${ind}<${v ? 'true' : 'false'}/>`);
  else if (typeof v === 'bigint') out.push(`${ind}<integer>${v.toString()}</integer>`);
  else if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new PlistError('not a finite number');
    out.push(Number.isInteger(v) ? `${ind}<integer>${v}</integer>` : `${ind}<real>${v}</real>`);
  } else if (v instanceof Date) out.push(`${ind}<date>${v.toISOString().replace(/\.[0-9]{3}Z$/, 'Z')}</date>`);
  else if (v instanceof Uint8Array) out.push(`${ind}<data>${Buffer.from(v).toString('base64')}</data>`);
  else if (Array.isArray(v)) {
    if (!v.length) { out.push(`${ind}<array/>`); return; }
    out.push(`${ind}<array>`);
    for (const x of v) write(x, ind + '\t', out);
    out.push(`${ind}</array>`);
  } else {
    const keys = Object.keys(v);
    if (!keys.length) { out.push(`${ind}<dict/>`); return; }
    out.push(`${ind}<dict>`);
    for (const k of keys) {
      if (XML_INVALID.test(k)) throw new PlistError('a key with control characters');
      out.push(`${ind}\t<key>${esc(k)}</key>`);
      write(v[k], ind + '\t', out);
    }
    out.push(`${ind}</dict>`);
  }
}

/** The standard DOCTYPE line: an identifier, never fetched by anything. */
export const PLIST_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">';

export function buildPlist(root: PlistValue): string {
  const out: string[] = [PLIST_HEADER, '<plist version="1.0">'];
  write(root, '', out);
  out.push('</plist>', '');
  return out.join('\n');
}
