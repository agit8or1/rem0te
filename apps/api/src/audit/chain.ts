/**
 * The tamper-evident audit chain (v0.28): what an entry's hash covers, and
 * how a chain is checked. No Nest and no Prisma client here — the API's
 * sealer, the verify CLI and the external export checker share it.
 *
 *   hash(n) = sha256( hash(n-1) + "\n" + canonical(entry n) )
 *   hash(0) = 64 zeros
 *
 * An entry is the row as it was sealed: its sequence number, id, time,
 * action, actor, address, resource, metadata, and the tenant / business /
 * actor ids in sealedRefs (deleting a business or a user may later null the
 * live columns; nothing else may change). A sequence number that never
 * committed (a failed insert consumes one) is named in the next row's
 * chainGap, so a gap the chain does not declare is a deletion.
 *
 * What it proves: an entry that was sealed and then altered, or deleted, is
 * detected — against the database alone for an attacker who cannot rewrite
 * every later hash, and against the copy exported off the host for one who
 * can. It cannot prove an event was ever logged.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

export const GENESIS = '0'.repeat(64);
export const ENTRY_VERSION = 1;

export interface Refs { tenantId: string | null; customerId: string | null; actorId: string | null }
export interface ChainRow {
  seq: bigint; id: string; createdAt: Date; action: string;
  tenantId: string | null; customerId: string | null; actorId: string | null;
  actorIp: string | null; actorAgent: string | null; resource: string | null; resourceId: string | null;
  metadata: unknown; chainHash: string | null; sealedRefs: unknown; chainGap: unknown;
}

/** Deterministic JSON: sorted keys, no undefined, numbers as JavaScript prints them. */
export function canon(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'number': return Number.isFinite(v) ? JSON.stringify(v) : JSON.stringify(String(v));
    case 'bigint': return JSON.stringify(v.toString());
    case 'object': {
      if (v instanceof Date) return JSON.stringify(v.toISOString());
      if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
    }
    default: return 'null';
  }
}

export function entryOf(r: ChainRow, refs: Refs, gap: [string, string] | null): string {
  return canon({
    v: ENTRY_VERSION, seq: r.seq.toString(), id: r.id, at: r.createdAt.toISOString(), action: r.action,
    tenantId: refs.tenantId, customerId: refs.customerId, actorId: refs.actorId,
    actorIp: r.actorIp, actorAgent: r.actorAgent, resource: r.resource, resourceId: r.resourceId,
    metadata: r.metadata ?? null, gapBefore: gap,
  });
}

export const link = (prev: string, entry: string) => createHash('sha256').update(`${prev}\n${entry}`).digest('hex');

export const refsOf = (r: Pick<ChainRow, 'tenantId' | 'customerId' | 'actorId'>): Refs => ({ tenantId: r.tenantId, customerId: r.customerId, actorId: r.actorId });

function sealedRefs(v: unknown): Refs | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === 'string' ? x : null);
  return { tenantId: s(o.tenantId), customerId: s(o.customerId), actorId: s(o.actorId) };
}
function gapOf(v: unknown): [string, string] | null {
  return Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string' && /^[0-9]+$/.test(x)) ? [v[0], v[1]] : null;
}

export interface Problem { seq: string; kind: 'altered' | 'deleted' | 'reference_changed' | 'unsealed_in_chain' | 'checkpoint_mismatch' | 'checkpoint_signature'; detail: string }
export interface VerifyState { prevSeq: bigint; prevHash: string; checked: number; problems: Problem[] }

export const startState = (afterSeq = 0n, afterHash = GENESIS): VerifyState => ({ prevSeq: afterSeq, prevHash: afterHash, checked: 0, problems: [] });

/**
 * Feed sealed rows in seq order. Stops recording after 50 problems (a broken
 * chain says so on the first; the rest are context).
 */
export function verifyRows(st: VerifyState, rows: ChainRow[]): VerifyState {
  for (const r of rows) {
    const add = (p: Problem) => { if (st.problems.length < 50) st.problems.push(p); };
    if (!r.chainHash) { add({ seq: r.seq.toString(), kind: 'unsealed_in_chain', detail: 'an unsealed row sits among sealed ones' }); continue; }
    const gap = gapOf(r.chainGap);
    const expected = st.prevSeq + 1n;
    if (r.seq !== expected) {
      const declared = gap && BigInt(gap[0]) === expected && BigInt(gap[1]) === r.seq - 1n;
      if (!declared) add({ seq: expected.toString(), kind: 'deleted', detail: `entries ${expected}–${r.seq - 1n} are missing and were not declared as never-committed` });
    } else if (gap) {
      add({ seq: r.seq.toString(), kind: 'altered', detail: 'declares a gap that does not exist' });
    }
    const refs = sealedRefs(r.sealedRefs);
    if (!refs) add({ seq: r.seq.toString(), kind: 'altered', detail: 'sealedRefs missing' });
    else {
      for (const k of ['tenantId', 'customerId', 'actorId'] as const) {
        if (r[k] !== null && r[k] !== refs[k]) add({ seq: r.seq.toString(), kind: 'reference_changed', detail: `${k} changed after sealing` });
      }
    }
    const h = link(st.prevHash, entryOf(r, refs ?? refsOf(r), gap));
    if (h !== r.chainHash) add({ seq: r.seq.toString(), kind: 'altered', detail: 'hash does not match the entry and the previous hash' });
    // Continue from the stored hash, so one altered entry is reported once
    // rather than breaking every later link.
    st.prevSeq = r.seq; st.prevHash = r.chainHash; st.checked++;
  }
  return st;
}

// ── Checkpoints ─────────────────────────────────────────────────────────────

export const CHECKPOINT_CONTEXT = 'rem0te-audit-checkpoint-v1\n';
export interface Checkpoint { seq: string; hash: string; at: string; keyId: string | null; signature: string | null }

export const checkpointBytes = (c: Pick<Checkpoint, 'seq' | 'hash' | 'at'>) => Buffer.from(CHECKPOINT_CONTEXT + canon({ seq: c.seq, hash: c.hash, at: c.at }), 'utf8');

export function loadKey(pem: string): { priv: KeyObject; pub: KeyObject; keyId: string } {
  const priv = createPrivateKey(pem);
  if (priv.asymmetricKeyType !== 'ed25519') throw new Error('audit checkpoint key must be Ed25519');
  const pub = createPublicKey(priv);
  return { priv, pub, keyId: keyIdOf(pub) };
}
export const keyIdOf = (pub: KeyObject) => createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);

export function signCheckpoint(c: Pick<Checkpoint, 'seq' | 'hash' | 'at'>, k: { priv: KeyObject; keyId: string }): Checkpoint {
  return { ...c, keyId: k.keyId, signature: sign(null, checkpointBytes(c), k.priv).toString('base64') };
}
export function checkCheckpoint(c: Checkpoint, pub: KeyObject): boolean {
  if (!c.signature || c.keyId !== keyIdOf(pub)) return false;
  try { return verify(null, checkpointBytes(c), pub, Buffer.from(c.signature, 'base64')); } catch { return false; }
}

// ── The export stream ───────────────────────────────────────────────────────
// One JSON object per line. An entry line carries the whole entry and its
// hash, so the export alone is a second copy of the record; checkpoint lines
// are signed. Format: rem0te-audit-export/1.

export const EXPORT_SCHEMA = 'rem0te-audit-export/1';
export type ExportLine =
  | { schema: typeof EXPORT_SCHEMA; type: 'entry'; seq: string; hash: string; prev: string; entry: string }
  | { schema: typeof EXPORT_SCHEMA; type: 'checkpoint'; checkpoint: Checkpoint };

// ── Checking an export ──────────────────────────────────────────────────────

export interface ExportCheck {
  ok: boolean; entries: number; startSeq: string; checkpoints: number; headSeq: string; headHash: string;
  /** seq → hash, for comparing against the database. */
  hashes: Map<string, string>;
  problems: Problem[];
}

/**
 * Check an export on its own: every entry links to the one before it, the
 * hash is the hash of the entry it carries, numbering has only declared gaps,
 * and every checkpoint names a hash the export holds (and, given the public
 * key, is signed by it). A line sent twice — the API resends after a failed
 * delivery — is accepted when it is identical.
 */
export function verifyExport(text: string, pub?: KeyObject): ExportCheck {
  const problems: Problem[] = [];
  const add = (p: Problem) => { if (problems.length < 50) problems.push(p); };
  const hashes = new Map<string, string>();
  let prevSeq = 0n, prevHash = GENESIS, entries = 0, checkpoints = 0, startSeq = '0';
  const cps: Checkpoint[] = [];
  let lineNo = 0;
  for (const raw of text.split('\n')) {
    lineNo++;
    if (!raw.trim()) continue;
    let l: ExportLine;
    try { l = JSON.parse(raw) as ExportLine; } catch { add({ seq: '?', kind: 'altered', detail: `line ${lineNo} is not JSON` }); continue; }
    if (l.schema !== EXPORT_SCHEMA) { add({ seq: '?', kind: 'altered', detail: `line ${lineNo} is not ${EXPORT_SCHEMA}` }); continue; }
    if (l.type === 'checkpoint') { cps.push(l.checkpoint); checkpoints++; continue; }
    if (l.type !== 'entry' || typeof l.seq !== 'string' || !/^[0-9]+$/.test(l.seq)) { add({ seq: '?', kind: 'altered', detail: `line ${lineNo} is malformed` }); continue; }
    const seq = BigInt(l.seq);
    const seen = hashes.get(l.seq);
    if (seen !== undefined) {
      if (seen !== l.hash) add({ seq: l.seq, kind: 'altered', detail: 'the export holds two different hashes for this entry' });
      continue;
    }
    if (seq <= prevSeq) { add({ seq: l.seq, kind: 'altered', detail: 'entries out of order' }); continue; }
    if (entries === 0 && seq !== 1n) {
      // A sink configured (or rotated) after the chain began starts mid-chain:
      // it is checked from its first entry, and reported as starting there.
      prevSeq = seq - 1n; prevHash = l.prev;
    }
    if (entries === 0) startSeq = l.seq;
    let gap: unknown = null;
    try { gap = (JSON.parse(l.entry) as { gapBefore?: unknown }).gapBefore ?? null; } catch { add({ seq: l.seq, kind: 'altered', detail: 'entry is not JSON' }); }
    if (seq !== prevSeq + 1n) {
      const g = gapOf(gap);
      if (!(g && BigInt(g[0]) === prevSeq + 1n && BigInt(g[1]) === seq - 1n)) add({ seq: (prevSeq + 1n).toString(), kind: 'deleted', detail: `entries ${prevSeq + 1n}–${seq - 1n} are missing from the export` });
    }
    if (l.prev !== prevHash) add({ seq: l.seq, kind: 'altered', detail: 'does not link to the previous entry' });
    if (link(l.prev, l.entry) !== l.hash) add({ seq: l.seq, kind: 'altered', detail: 'hash does not match the entry' });
    hashes.set(l.seq, l.hash);
    prevSeq = seq; prevHash = l.hash; entries++;
  }
  for (const c of cps) {
    const h = hashes.get(c.seq);
    if (h !== c.hash) add({ seq: c.seq, kind: 'checkpoint_mismatch', detail: h ? 'checkpoint hash differs from the exported entry' : 'checkpoint names an entry the export does not hold' });
    if (pub && !checkCheckpoint(c, pub)) add({ seq: c.seq, kind: 'checkpoint_signature', detail: 'checkpoint is not signed by the given key' });
  }
  return { ok: problems.length === 0, entries, startSeq, checkpoints, headSeq: prevSeq.toString(), headHash: prevHash, hashes, problems };
}
