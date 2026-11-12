import { z } from 'zod';
import { Parameters, sha256Hex, definitionSha256 } from '../actions/script-run';

/**
 * Script library: what a version IS, and how it is hashed.
 *
 * Pure: no Nest, no Prisma, so unit-script-library.mjs can load it from dist.
 * Nothing here runs a script, and nothing in the script library can: a run
 * is the signed catalog action windows.script.run@1, requested through the
 * script-run module (docs/script-library.md).
 *
 * Two hashes per version:
 *   contentSha256    — the exact UTF-8 bytes. What an agent would verify.
 *   definitionSha256 — the language, OS, risk, parameters and content hash,
 *                      as canonical JSON. What a reviewer approved ABOUT it.
 */

// The parameter rules, the content rule and the hashes are shared with the
// run path (0.34): the portal's run request, the approval signer and the
// agent check arguments against exactly these declarations, so there is one
// copy, in actions/script-run.ts (pure; the signer loads it).
export {
  MAX_CONTENT_BYTES, MAX_PARAMETERS, DEFINITION_PREFIX, CHARSETS, ParameterDecl, Parameters, contentProblem, sha256Hex, canonical, definitionSha256,
  type Charset,
} from '../actions/script-run';

export const LANGUAGES = ['powershell'] as const;
export const TARGET_OS = ['windows'] as const;
export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];

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
