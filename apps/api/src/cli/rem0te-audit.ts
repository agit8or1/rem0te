/**
 * Evidence and containment, on the server host (v0.28). Talks to the
 * database directly (DATABASE_URL), so it works with the API down.
 *
 *   sudo bash -c 'set -a; . /etc/reboot-remote/api.env; set +a; cd /opt/reboot-remote/api && node dist/cli/rem0te-audit.js verify'
 *
 * verify [--export FILE] [--pub FILE]
 *     Recompute the audit chain in the database. With --export, also check
 *     the exported copy on its own and compare the two entry by entry — the
 *     comparison is what catches someone who rewrote the database chain from
 *     end to end. With --pub, checkpoint signatures are checked against that
 *     Ed25519 public key (keep it off the host).
 * verify-export FILE [--pub FILE]
 *     Check an export alone, anywhere — no database needed.
 * keygen --out FILE
 *     Write a new Ed25519 checkpoint key (mode 0600) and print its public key.
 * containment list
 * containment clear --id ID --reason TEXT [--yes]
 *     Lift a portal pause from the host: the escape hatch when the people who
 *     could lift it in the portal cannot. Audited. It does not lift the
 *     approval signer's copy (its own CLI) or a signed pause (a release).
 *
 * Exit status: 0 good, 1 a problem was found, 2 usage.
 */
import { PrismaClient } from '@prisma/client';
import { createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { keyIdOf, startState, verifyExport, verifyRows, checkCheckpoint, type ChainRow, type Problem } from '../audit/chain';

const USAGE = `Usage: node dist/cli/rem0te-audit.js <command>
  verify [--export FILE] [--pub FILE]       check the database chain (and an export against it)
  verify-export FILE [--pub FILE]           check an export alone (no database)
  keygen --out FILE                         new Ed25519 checkpoint key
  containment list                          active portal pauses
  containment clear --id ID --reason TEXT [--yes]`;

class UsageError extends Error {}
const ROW_SELECT = {
  seq: true, id: true, createdAt: true, action: true, tenantId: true, customerId: true, actorId: true, actorIp: true, actorAgent: true,
  resource: true, resourceId: true, metadata: true, chainHash: true, sealedRefs: true, chainGap: true,
} as const;

function pubFrom(file: string | undefined): KeyObject | undefined {
  if (!file) return undefined;
  const k = createPublicKey(readFileSync(file, 'utf8'));
  if (k.asymmetricKeyType !== 'ed25519') throw new UsageError('--pub must be an Ed25519 public key');
  return k;
}
// Checkpoint problems first: a bad or missing signature says the copy itself
// cannot be trusted, and it must not be pushed past the 20-line cut by a run
// of ordinary deletions (0.29 — e2e-containment caught exactly that).
const RANK: Record<Problem['kind'], number> = { checkpoint_signature: 0, checkpoint_mismatch: 1, altered: 2, reference_changed: 3, unsealed_in_chain: 4, deleted: 5 };
const report = (label: string, problems: Problem[]) => {
  const ordered = [...problems].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  for (const p of ordered.slice(0, 20)) console.log(`  ${label} seq ${p.seq}: ${p.kind} — ${p.detail}`);
  if (problems.length > 20) {
    const counts = Object.entries(problems.reduce<Record<string, number>>((m, p) => ({ ...m, [p.kind]: (m[p.kind] ?? 0) + 1 }), {})).map(([k, n]) => `${n} ${k}`).join(', ');
    console.log(`  … and ${problems.length - 20} more (${counts} in all)`);
  }
};

async function main(argv: string[]): Promise<number> {
  const val = (f: string) => { const i = argv.indexOf(f); const v = i >= 0 ? argv[i + 1] : undefined; if (i >= 0 && (!v || v.startsWith('--'))) throw new UsageError(`${f} needs a value`); return v; };
  const [cmd, sub] = argv;

  if (cmd === 'keygen') {
    const out = val('--out');
    if (!out) throw new UsageError('keygen needs --out FILE');
    if (existsSync(out)) throw new UsageError(`${out} exists; refusing to overwrite a key`);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    console.log(`Wrote ${out} (key id ${keyIdOf(publicKey)}). Public key — store it OFF this host, for verify --pub:\n`);
    console.log(publicKey.export({ type: 'spki', format: 'pem' }).toString());
    return 0;
  }

  if (cmd === 'verify-export') {
    if (!sub || sub.startsWith('--')) throw new UsageError('verify-export needs a FILE');
    const r = verifyExport(readFileSync(sub, 'utf8'), pubFrom(val('--pub')));
    console.log(`export: ${r.entries} entries, seq ${r.startSeq}–${r.headSeq}, ${r.checkpoints} checkpoints — ${r.ok ? 'intact' : 'PROBLEMS'}`);
    report('export', r.problems);
    return r.ok ? 0 : 1;
  }

  if (cmd !== 'verify' && cmd !== 'containment') { console.log(USAGE); return cmd === '--help' ? 0 : 2; }
  if (!process.env.DATABASE_URL) throw new UsageError('DATABASE_URL is not set. Load the API environment first (see --help).');
  const prisma = new PrismaClient();
  try {
    if (cmd === 'verify') {
      const pub = pubFrom(val('--pub'));
      let st = startState();
      let cursor = 0n;
      const db = new Map<string, string>();
      for (;;) {
        const rows = await prisma.activityLog.findMany({ where: { seq: { gt: cursor }, chainHash: { not: null } }, orderBy: { seq: 'asc' }, take: 2000, select: ROW_SELECT }) as ChainRow[];
        if (!rows.length) break;
        st = verifyRows(st, rows);
        for (const r of rows) db.set(r.seq.toString(), r.chainHash!);
        cursor = rows[rows.length - 1].seq;
      }
      const state = await prisma.auditChainState.findUnique({ where: { id: 'chain' } });
      if (state && st.prevSeq < state.headSeq) st.problems.push({ seq: state.headSeq.toString(), kind: 'deleted', detail: `the head is ${state.headSeq} but the last sealed entry is ${st.prevSeq}` });
      for (const c of await prisma.auditCheckpoint.findMany({ orderBy: { seq: 'asc' } })) {
        if (db.get(c.seq.toString()) !== c.hash) st.problems.push({ seq: c.seq.toString(), kind: 'checkpoint_mismatch', detail: 'checkpoint hash differs from the entry' });
        if (pub && !checkCheckpoint({ seq: c.seq.toString(), hash: c.hash, at: c.at.toISOString(), keyId: c.keyId, signature: c.signature }, pub)) st.problems.push({ seq: c.seq.toString(), kind: 'checkpoint_signature', detail: c.signature ? 'not signed by the given key' : 'unsigned' });
      }
      const unsealed = await prisma.activityLog.count({ where: { chainHash: null } });
      console.log(`database: ${st.checked} sealed entries through seq ${st.prevSeq}, ${unsealed} not yet sealed — ${st.problems.length ? 'PROBLEMS' : 'intact'}`);
      report('database', st.problems);
      let bad = st.problems.length > 0;
      const exportFile = val('--export');
      if (exportFile) {
        const x = verifyExport(readFileSync(exportFile, 'utf8'), pub);
        console.log(`export:   ${x.entries} entries, seq ${x.startSeq}–${x.headSeq}, ${x.checkpoints} checkpoints — ${x.ok ? 'intact' : 'PROBLEMS'}`);
        report('export', x.problems);
        const diff: Problem[] = [];
        for (const [seq, h] of x.hashes) {
          const d = db.get(seq);
          if (d === undefined) diff.push({ seq, kind: 'deleted', detail: 'in the export, not in the database' });
          else if (d !== h) diff.push({ seq, kind: 'altered', detail: 'the database entry differs from the exported one' });
        }
        console.log(`compare:  ${diff.length ? `${diff.length} DIFFERENCES` : 'every exported entry matches the database'}${BigInt(x.headSeq) < st.prevSeq ? ` (the database is ${st.prevSeq - BigInt(x.headSeq)} entries ahead of the export)` : ''}`);
        report('compare', diff);
        bad = bad || !x.ok || diff.length > 0;
      }
      return bad ? 1 : 0;
    }

    // containment
    if (sub === 'list') {
      const rows = await prisma.containmentPause.findMany({ where: { clearedAt: null }, orderBy: { createdAt: 'asc' }, include: { customer: { select: { name: true } } } });
      if (!rows.length) console.log('No active portal pauses.');
      for (const p of rows) console.log(`${p.id}  ${p.scope === 'GLOBAL' ? 'global' : `business ${p.customer?.name ?? p.customerId}`}  [${p.kinds.join(',')}]  set by ${p.setBy} ${p.createdAt.toISOString()}  — ${p.reason}`);
      return 0;
    }
    if (sub === 'clear') {
      const id = val('--id'); const reason = val('--reason')?.trim();
      if (!id || !reason || reason.length < 3) throw new UsageError('containment clear needs --id ID and --reason TEXT (3+ characters)');
      const p = await prisma.containmentPause.findUnique({ where: { id }, include: { customer: { select: { tenantId: true } } } });
      if (!p || p.clearedAt) { console.error('No active pause with that id.'); return 1; }
      console.log(`${argv.includes('--yes') ? 'Lifting' : 'Would lift'} ${p.scope.toLowerCase()} pause ${p.id} [${p.kinds.join(',')}] set by ${p.setBy}: ${p.reason}`);
      if (!argv.includes('--yes')) { console.log('Dry run. Add --yes to lift it.'); return 0; }
      await prisma.$transaction([
        prisma.containmentPause.update({ where: { id }, data: { clearedAt: new Date(), clearedById: null, clearReason: `host CLI: ${reason}`.slice(0, 300) } }),
        prisma.activityLog.create({ data: { action: 'CONTAINMENT_CLEARED', tenantId: p.customer?.tenantId ?? null, customerId: p.customerId, resource: 'containment_pause', resourceId: id, actorAgent: 'rem0te-audit-cli', metadata: { viaHostCli: true, scope: p.scope.toLowerCase(), kinds: p.kinds, reason, setBy: p.setBy } } }),
      ]);
      if (p.signerRequestedAt) console.log('The approval signer still holds its copy; lift it with the signer CLI (pause clear) once you are sure.');
      return 0;
    }
    throw new UsageError('containment list | containment clear --id ID --reason TEXT [--yes]');
  } finally {
    await prisma.$disconnect();
  }
}

main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => {
  if (e instanceof UsageError) { console.error(e.message); console.error(USAGE); process.exit(2); }
  console.error(e); process.exit(1);
});
