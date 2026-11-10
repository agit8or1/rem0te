#!/usr/bin/env node
// Tests for the tamper-evident audit chain (src/audit/chain.ts), run against dist:
//
//   node apps/api/scripts/unit-audit-chain.mjs
//
// Pure functions only — seal synthetic rows the way the sealer does, then
// alter, delete, renumber and re-reference them and check each is caught,
// in the database chain and in the export.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const c = require(join(here, '..', 'dist', 'audit', 'chain.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) passed++; else failures.push(`${name}${detail ? ` — ${detail}` : ''}`); };

function row(seq, extra = {}) {
  return {
    seq: BigInt(seq), id: `row${seq}`, createdAt: new Date(Date.UTC(2026, 10, 10, 0, 0, seq)), action: 'USER_LOGIN',
    tenantId: 't1', customerId: seq % 2 ? 'biz-aaaaaaa' : null, actorId: 'u1', actorIp: '10.0.0.1', actorAgent: null,
    resource: 'user', resourceId: 'u1', metadata: { n: seq, nested: { b: 1, a: [1, 'x'] } }, chainHash: null, sealedRefs: null, chainGap: null, ...extra,
  };
}
/** Seal like AuditChainService.seal: gaps declared, refs recorded. */
function seal(rows) {
  let head = 0n, hash = c.GENESIS;
  for (const r of rows) {
    const gap = r.seq !== head + 1n ? [(head + 1n).toString(), (r.seq - 1n).toString()] : null;
    const refs = c.refsOf(r);
    r.chainHash = c.link(hash, c.entryOf(r, refs, gap));
    r.sealedRefs = refs; r.chainGap = gap;
    head = r.seq; hash = r.chainHash;
  }
  return rows;
}
function exportOf(rows, cps = []) {
  let prev = c.GENESIS;
  const lines = rows.map((r) => { const l = { schema: c.EXPORT_SCHEMA, type: 'entry', seq: r.seq.toString(), hash: r.chainHash, prev, entry: c.entryOf(r, r.sealedRefs, r.chainGap) }; prev = r.chainHash; return l; });
  for (const cp of cps) lines.push({ schema: c.EXPORT_SCHEMA, type: 'checkpoint', checkpoint: cp });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
const verify = (rows) => c.verifyRows(c.startState(), rows);
const kinds = (st) => st.problems.map((p) => p.kind);
const fresh = () => seal([1, 2, 3, 4, 6, 7, 8].map((s) => row(s)));  // 5 never committed

// canon is key-order independent and stable
check('canon sorts keys', c.canon({ b: 1, a: { d: 2, c: [3, null] } }) === '{"a":{"c":[3,null],"d":2},"b":1}');
check('canon bigint/date', c.canon({ s: 5n, t: new Date(0) }) === '{"s":"5","t":"1970-01-01T00:00:00.000Z"}');
check('canon drops undefined', c.canon({ a: undefined, b: 1 }) === '{"b":1}');

// intact chain, with a declared gap
{ const st = verify(fresh()); check('intact chain verifies', st.problems.length === 0 && st.checked === 7, JSON.stringify(st.problems)); }

// metadata altered
{ const rows = fresh(); rows[2].metadata = { n: 999 }; const st = verify(rows); check('altered metadata detected', kinds(st).includes('altered') && st.problems[0].seq === '3'); check('one alteration reported once', st.problems.length === 1, JSON.stringify(st.problems)); }
// action altered
{ const rows = fresh(); rows[0].action = 'USER_LOGOUT'; check('altered action detected', kinds(verify(rows)).includes('altered')); }
// time altered
{ const rows = fresh(); rows[1].createdAt = new Date(0); check('altered time detected', kinds(verify(rows)).includes('altered')); }
// deletion in the middle
{ const rows = fresh(); rows.splice(1, 1); const st = verify(rows); check('deleted entry detected', kinds(st).includes('deleted') && st.problems.some((p) => p.seq === '2'), JSON.stringify(st.problems)); }
// deleting the row after a gap re-exposes it
{ const rows = fresh(); rows.splice(4, 1); check('deleting the row declaring a gap is detected', kinds(verify(rows)).includes('deleted')); }
// forging a gap declaration on a deletion: the hash covers chainGap
{ const rows = fresh(); rows.splice(1, 1); rows[1].chainGap = ['2', '2']; check('forged gap declaration detected', kinds(verify(rows)).includes('altered')); }
// a gap declared where none exists
{ const rows = fresh(); rows[1].chainGap = ['2', '1']; check('spurious gap detected', kinds(verify(rows)).includes('altered')); }
// reference nulled (business deleted): allowed
{ const rows = fresh(); rows[0].customerId = null; rows[0].actorId = null; check('nulled references are allowed', verify(rows).problems.length === 0); }
// reference changed: not allowed
{ const rows = fresh(); rows[0].customerId = 'biz-bbbbbbb'; check('changed reference detected', kinds(verify(rows)).includes('reference_changed')); }
// sealedRefs rewritten too
{ const rows = fresh(); rows[0].customerId = 'biz-bbbbbbb'; rows[0].sealedRefs = { ...rows[0].sealedRefs, customerId: 'biz-bbbbbbb' }; check('rewritten sealedRefs detected', kinds(verify(rows)).includes('altered')); }
// unsealed row in the middle
{ const rows = fresh(); rows[3].chainHash = null; check('unsealed row among sealed detected', kinds(verify(rows)).includes('unsealed_in_chain')); }
// full rewrite: every hash recomputed — the database chain is self-consistent again
{ const rows = fresh(); rows[2].metadata = { n: 999 }; for (const r of rows) r.chainHash = null; seal(rows); check('a full rewrite is self-consistent (why the export exists)', verify(rows).problems.length === 0); }

// checkpoints
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const key = c.loadKey(pem);
check('keyId is 16 hex', /^[0-9a-f]{16}$/.test(key.keyId));
const rows = fresh();
const cp = c.signCheckpoint({ seq: '8', hash: rows[6].chainHash, at: '2026-11-10T00:15:00.000Z' }, key);
check('checkpoint verifies', c.checkCheckpoint(cp, publicKey));
check('checkpoint with altered hash fails', !c.checkCheckpoint({ ...cp, hash: '0'.repeat(64) }, publicKey));
check('checkpoint with altered seq fails', !c.checkCheckpoint({ ...cp, seq: '7' }, publicKey));
check('checkpoint under another key fails', !c.checkCheckpoint(cp, generateKeyPairSync('ed25519').publicKey));
check('unsigned checkpoint fails', !c.checkCheckpoint({ ...cp, signature: null }, publicKey));
let threw = false; try { c.loadKey(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })); } catch { threw = true; }
check('a non-Ed25519 key is refused', threw);

// the export
{ const x = c.verifyExport(exportOf(rows, [cp]), publicKey); check('export verifies', x.ok && x.entries === 7 && x.checkpoints === 1 && x.headSeq === '8', JSON.stringify(x.problems)); }
{ const t = exportOf(rows, [cp]); const lines = t.trim().split('\n'); const dup = [lines[0], lines[1], lines[1], ...lines.slice(2)].join('\n'); check('a resent identical line is accepted', c.verifyExport(dup, publicKey).ok); }
{ const lines = exportOf(rows).trim().split('\n'); lines.splice(2, 1); const x = c.verifyExport(lines.join('\n')); check('a line dropped from the export is detected', !x.ok && x.problems.some((p) => p.kind === 'deleted' || p.kind === 'altered')); }
{ const lines = exportOf(rows).trim().split('\n').map((l) => JSON.parse(l)); lines[3].entry = lines[3].entry.replace('USER_LOGIN', 'USER_LOGOUT'); const x = c.verifyExport(lines.map((l) => JSON.stringify(l)).join('\n')); check('an edited export entry is detected', !x.ok && x.problems.some((p) => p.seq === lines[3].seq)); }
{ const x = c.verifyExport(exportOf(rows, [{ ...cp, hash: 'f'.repeat(64) }])); check('export checkpoint mismatch detected', x.problems.some((p) => p.kind === 'checkpoint_mismatch')); }
{ const x = c.verifyExport(exportOf(rows, [cp]), generateKeyPairSync('ed25519').publicKey); check('export checkpoint under the wrong key detected', x.problems.some((p) => p.kind === 'checkpoint_signature')); }
// A checkpoint written before a key was configured carries no signature: it is
// counted, not a problem (as in the database check) — a key turned on later
// must not leave the export failing for good. A bad signature still fails.
{ const x = c.verifyExport(exportOf(rows, [{ ...cp, keyId: null, signature: null }, cp]), publicKey); check('an unsigned (pre-key) checkpoint is counted, not a problem', x.ok && x.unsignedCheckpoints === 1, JSON.stringify(x.problems)); }
{ const x = c.verifyExport(exportOf(rows, [{ ...cp, signature: Buffer.alloc(64).toString('base64') }]), publicKey); check('a checkpoint with a signature that does not verify is still a problem', x.problems.some((p) => p.kind === 'checkpoint_signature')); }
{ const lines = exportOf(rows).trim().split('\n'); const x = c.verifyExport(lines.slice(4).join('\n')); check('an export that starts mid-chain is checked from its first entry', x.ok && x.startSeq === '6' && x.entries === 3, JSON.stringify(x.problems)); }
{ const lines = exportOf(rows).trim().split('\n'); const x = c.verifyExport([...lines.slice(0, 2), ...lines.slice(3)].join('\n')); check('a dropped line mid-file is still detected', !x.ok); }
// The point of the export: a full database rewrite still differs from it.
{
  const exported = c.verifyExport(exportOf(rows));
  const rewritten = fresh(); rewritten[2].metadata = { n: 999 }; for (const r of rewritten) r.chainHash = null; seal(rewritten);
  const diffs = rewritten.filter((r) => exported.hashes.get(r.seq.toString()) !== r.chainHash).map((r) => r.seq.toString());
  check('a full database rewrite differs from the export from the altered entry on', diffs[0] === '3' && diffs.length === 5, diffs.join(','));
}

if (failures.length) { console.error(`audit chain: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  ✗ ${f}`); process.exit(1); }
console.log(`audit chain: ${passed} passed`);
