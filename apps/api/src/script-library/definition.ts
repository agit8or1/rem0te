import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Script library: what a version IS, and how it is hashed.
 *
 * Pure: no Nest, no Prisma, so unit-script-library.mjs can load it from dist
 * and the approval signer could one day load the same rules. Nothing here
 * runs a script, and nothing in the script library can (docs/script-library.md).
 *
 * Two hashes per version:
 *   contentSha256    — the exact UTF-8 bytes. What an agent would verify.
 *   definitionSha256 — the language, OS, risk, parameters and content hash,
 *                      as canonical JSON. What a reviewer approved ABOUT it.
 */

export const MAX_CONTENT_BYTES = 65_536;
export const MAX_PARAMETERS = 10;
export const DEFINITION_PREFIX = 'rem0te-script-definition-v1\n';

export const LANGUAGES = ['powershell'] as const;
export const TARGET_OS = ['windows'] as const;
export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];

/**
 * Closed charsets for string parameters. Not author-supplied regexes: the
 * agent must enforce exactly the same rule, in Go, and a closed list can be
 * implemented identically and cannot be a catastrophic regex. None admits a
 * quote, `$`, a backtick, `;`, `|`, `&`, parentheses or a newline.
 */
export const CHARSETS = {
  alphanumeric: /^[A-Za-z0-9]*$/,
  identifier: /^[A-Za-z0-9_.-]*$/,
  hostname: /^[A-Za-z0-9.-]*$/,
  safe_text: /^[A-Za-z0-9 _.,:@-]*$/,
} as const;
export type Charset = keyof typeof CHARSETS;
const CHARSET_NAMES = Object.keys(CHARSETS) as [Charset, ...Charset[]];

const ParamName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/, 'a parameter name is a letter then up to 31 letters, digits or _');
const ParamDescription = z.string().trim().max(200).optional();

export const ParameterDecl = z.discriminatedUnion('type', [
  z.object({ name: ParamName, type: z.literal('string'), description: ParamDescription, required: z.boolean(), charset: z.enum(CHARSET_NAMES), maxLength: z.number().int().min(1).max(256) }).strict(),
  z.object({ name: ParamName, type: z.literal('integer'), description: ParamDescription, required: z.boolean(), min: z.number().int().min(-2_147_483_648).max(2_147_483_647), max: z.number().int().min(-2_147_483_648).max(2_147_483_647) }).strict()
    .refine((p) => p.min <= p.max, { message: 'min must not exceed max' }),
  z.object({ name: ParamName, type: z.literal('boolean'), description: ParamDescription, required: z.boolean() }).strict(),
  z.object({ name: ParamName, type: z.literal('choice'), description: ParamDescription, required: z.boolean(), choices: z.array(z.string().regex(CHARSETS.identifier).min(1).max(64)).min(1).max(20) }).strict()
    .refine((p) => new Set(p.choices).size === p.choices.length, { message: 'choices must be distinct' }),
]);
export type ParameterDecl = z.infer<typeof ParameterDecl>;

export const Parameters = z.array(ParameterDecl).max(MAX_PARAMETERS)
  .refine((ps) => new Set(ps.map((p) => p.name.toLowerCase())).size === ps.length, { message: 'parameter names must be distinct (PowerShell parameter names are case-insensitive)' });

/** The executable definition of a version: everything but the text itself and who wrote it. */
export const VersionFields = z.object({
  description: z.string().trim().min(3).max(2000),
  language: z.enum(LANGUAGES).default('powershell'),
  targetOs: z.enum(TARGET_OS).default('windows'),
  risk: z.enum(RISKS),
  parameters: Parameters.default([]),
  content: z.string(),
}).strict();
export type VersionFields = z.infer<typeof VersionFields>;

/** Why this content cannot be stored, or null. Bytes are hashed exactly as given. */
export function contentProblem(content: string): string | null {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes === 0 || content.trim() === '') return 'The script is empty.';
  if (bytes > MAX_CONTENT_BYTES) return `The script is ${bytes} bytes; the limit is ${MAX_CONTENT_BYTES}.`;
  // A lone surrogate would not survive a UTF-8 round trip, so the stored text
  // would not hash to what was shown.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)) {
    return 'The script contains text that is not valid UTF-8.';
  }
  // eslint-disable-next-line no-control-regex
  const ctl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.exec(content);
  if (ctl) return `The script contains a control character (U+${ctl[0].charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}). Only tab, CR and LF are allowed.`;
  return null;
}

export const sha256Hex = (s: string | Buffer) => createHash('sha256').update(typeof s === 'string' ? Buffer.from(s, 'utf8') : s).digest('hex');

/** Canonical JSON: sorted keys, no whitespace. Arrays keep their order. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export function definitionSha256(d: { language: string; targetOs: string; risk: string; parameters: ParameterDecl[]; contentSha256: string }): string {
  return sha256Hex(DEFINITION_PREFIX + canonical({ language: d.language, targetOs: d.targetOs, risk: d.risk, parameters: d.parameters, contentSha256: d.contentSha256 }));
}

export interface Hashed { contentSha256: string; contentBytes: number; definitionSha256: string }
export function hashVersion(v: Pick<VersionFields, 'language' | 'targetOs' | 'risk' | 'parameters' | 'content'>): Hashed {
  const contentSha256 = sha256Hex(v.content);
  return { contentSha256, contentBytes: Buffer.byteLength(v.content, 'utf8'), definitionSha256: definitionSha256({ ...v, contentSha256 }) };
}

/**
 * Who wrote this version's content and has not been independently reviewed:
 * its author, plus the contributors of the version it was edited from unless
 * that version was approved. None of them may approve it. Without this, A
 * writes v1, B makes a one-character edit as v2, and A approves v2 — A's own
 * code, approved by A.
 */
export function contributorsOf(authorId: string, base: { status: string; contributorIds: string[] } | null): string[] {
  const out = new Set<string>([authorId]);
  if (base && base.status !== 'APPROVED') for (const c of base.contributorIds) out.add(c);
  return [...out];
}

// ── Line diff (Myers, O((N+M)·D)) ────────────────────────────────────────────

export type DiffLine = { op: ' ' | '+' | '-'; text: string; a?: number; b?: number };
export const MAX_DIFF_EDITS = 4000;

/**
 * Line diff between two versions. Bounded: content is at most 64 KiB, and a
 * diff needing more than MAX_DIFF_EDITS edits is reported as `tooLarge`
 * (with the whole of both sides left to the reader) rather than computed.
 */
export function lineDiff(aText: string, bText: string): { lines: DiffLine[]; added: number; removed: number; tooLarge: boolean } {
  const a = aText.split(/\r?\n/), b = bText.split(/\r?\n/);
  const n = a.length, m = b.length, max = Math.min(n + m, MAX_DIFF_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    if (found >= 0) break;
  }
  if (found < 0) return { lines: [], added: 0, removed: 0, tooLarge: true };
  const out: DiffLine[] = [];
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1])) ? k + 1 : k - 1;
    const px = vd[off + prevK], py = px - prevK;
    while (x > px && y > py) { x--; y--; out.push({ op: ' ', text: a[x], a: x + 1, b: y + 1 }); }
    if (x === px) { y--; out.push({ op: '+', text: b[y], b: y + 1 }); } else { x--; out.push({ op: '-', text: a[x], a: x + 1 }); }
  }
  while (x > 0 && y > 0) { x--; y--; out.push({ op: ' ', text: a[x], a: x + 1, b: y + 1 }); }
  out.reverse();
  return { lines: out, added: out.filter((l) => l.op === '+').length, removed: out.filter((l) => l.op === '-').length, tooLarge: false };
}
