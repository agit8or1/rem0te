import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { appendFileSync, readFileSync } from 'node:fs';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import {
  EXPORT_SCHEMA, GENESIS, checkCheckpoint, entryOf, link, loadKey, refsOf, signCheckpoint, startState, verifyRows,
  type ChainRow, type Checkpoint, type ExportLine, type Problem,
} from './chain';

/**
 * Seals, exports and verifies the audit chain (v0.28). See ./chain.ts for
 * what a hash covers.
 *
 *   seal    every 5 s: hash new rows onto the head, in seq order
 *   export  after sealing, when AUDIT_EXPORT_FILE and/or AUDIT_EXPORT_URL is
 *           set: ship sealed entries and signed checkpoints off the host
 *   verify  at start and hourly: recompute the whole chain and check every
 *           checkpoint
 *
 * One sealer at a time, across processes, by a Postgres advisory lock.
 */
const LOCK_KEY = 728_001; // pg advisory lock id for the sealer
const SEAL_EVERY_MS = 5_000;
const VERIFY_EVERY_MS = 60 * 60_000;
/** A gap younger than this may be an insert still committing; wait for it. */
const GAP_GRACE_MS = 30_000;
/** AUDIT_CHECKPOINT_INTERVAL_SECONDS, default 900 (15 min), at least 5. */
const CHECKPOINT_EVERY_MS = Math.max(5, Number(process.env.AUDIT_CHECKPOINT_INTERVAL_SECONDS) || 900) * 1000;
const BATCH = 500;

const ROW_SELECT = {
  seq: true, id: true, createdAt: true, action: true, tenantId: true, customerId: true, actorId: true, actorIp: true, actorAgent: true,
  resource: true, resourceId: true, metadata: true, chainHash: true, sealedRefs: true, chainGap: true,
} as const;

export interface ChainStatus {
  headSeq: string; sealedAt: Date | null; unsealed: number; sealLagSeconds: number | null;
  export: { configured: string[]; exportedThroughSeq: string; exportedAt: Date | null; error: string | null; lagSeconds: number | null };
  verify: { at: Date | null; throughSeq: string; ok: boolean | null; problems: Problem[]; checked: number };
  checkpoints: { signed: boolean; keyId: string | null; last: { seq: string; at: Date } | null };
}

@Injectable()
export class AuditChainService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditChainService.name);
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  private key: ReturnType<typeof loadKey> | null = null;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  onModuleInit() {
    const f = process.env.AUDIT_CHECKPOINT_KEY_FILE;
    if (f) {
      try { this.key = loadKey(readFileSync(f, 'utf8')); } catch (e) { this.logger.error(`AUDIT_CHECKPOINT_KEY_FILE unusable, checkpoints will be unsigned: ${(e as Error).message}`); }
    }
    if (process.env.AUDIT_SEALER === 'off') return;
    this.timers.push(setInterval(() => { void this.tick(); }, SEAL_EVERY_MS));
    this.timers.push(setTimeout(() => { void this.verify().catch((e) => this.logger.error(`audit verify: ${e}`)); }, 20_000));
    this.timers.push(setInterval(() => { void this.verify().catch((e) => this.logger.error(`audit verify: ${e}`)); }, VERIFY_EVERY_MS));
  }
  onModuleDestroy() { for (const t of this.timers) clearInterval(t); }

  /** One seal (and export) pass. Public for tests and the CLI. */
  async tick(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      while ((await this.seal(now)) === BATCH) { /* more waiting */ }
      await this.exportPending(now);
    } catch (e) {
      this.logger.error(`audit seal/export: ${(e as Error).message}`);
    } finally { this.busy = false; }
  }

  private async state() {
    return this.prisma.auditChainState.upsert({ where: { id: 'chain' }, create: { id: 'chain' }, update: {} });
  }

  /** Seal up to BATCH rows; returns how many. */
  async seal(now = new Date()): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${LOCK_KEY}) AS locked`;
      if (!locked) return 0;
      const st = await tx.auditChainState.upsert({ where: { id: 'chain' }, create: { id: 'chain' }, update: {} });
      const rows = await tx.activityLog.findMany({ where: { seq: { gt: st.headSeq } }, orderBy: { seq: 'asc' }, take: BATCH, select: ROW_SELECT }) as ChainRow[];
      let head = st.headSeq, hash = st.headHash, n = 0;
      for (const r of rows) {
        let gap: [string, string] | null = null;
        if (r.seq !== head + 1n) {
          // Wait out an insert that may still be committing; after the grace
          // the missing numbers are declared, and hashed into this row.
          if (now.getTime() - r.createdAt.getTime() < GAP_GRACE_MS) break;
          gap = [(head + 1n).toString(), (r.seq - 1n).toString()];
        }
        if (r.chainHash) { // already sealed by an earlier pass that lost its state write: trust nothing, stop
          this.logger.error(`audit seal: row ${r.seq} is sealed ahead of the head (${head}); verify the chain`);
          break;
        }
        const refs = refsOf(r);
        const h = link(hash, entryOf(r, refs, gap));
        const u = await tx.activityLog.updateMany({
          where: { id: r.id, chainHash: null },
          data: { chainHash: h, sealedRefs: refs as unknown as Prisma.InputJsonValue, chainGap: gap ? (gap as unknown as Prisma.InputJsonValue) : Prisma.DbNull, sealedAt: now },
        });
        if (u.count !== 1) break;
        head = r.seq; hash = h; n++;
      }
      if (n) await tx.auditChainState.update({ where: { id: 'chain' }, data: { headSeq: head, headHash: hash, sealedAt: now } });
      return n;
    }, { timeout: 30_000 });
  }

  private sinks(): string[] {
    return [process.env.AUDIT_EXPORT_FILE ? 'file' : null, process.env.AUDIT_EXPORT_URL ? 'url' : null].filter((x): x is string => !!x);
  }

  /** A checkpoint at the head, when one is due. Stored, and returned for export. */
  private async checkpointIfDue(now: Date): Promise<Checkpoint | null> {
    const st = await this.state();
    if (st.headSeq === 0n) return null;
    const last = await this.prisma.auditCheckpoint.findFirst({ orderBy: { seq: 'desc' } });
    if (last && (last.seq === st.headSeq || now.getTime() - last.at.getTime() < CHECKPOINT_EVERY_MS)) return null;
    const base = { seq: st.headSeq.toString(), hash: st.headHash, at: now.toISOString() };
    const c: Checkpoint = this.key ? signCheckpoint(base, this.key) : { ...base, keyId: null, signature: null };
    await this.prisma.auditCheckpoint.create({ data: { seq: st.headSeq, hash: c.hash, at: now, keyId: c.keyId, signature: c.signature } });
    return c;
  }

  async exportPending(now = new Date()) {
    const cp = await this.checkpointIfDue(now);
    const sinks = this.sinks();
    if (!sinks.length) return;
    const st = await this.state();
    if (st.exportedThroughSeq >= st.headSeq && !cp) return;
    const rows = await this.prisma.activityLog.findMany({
      where: { seq: { gt: st.exportedThroughSeq, lte: st.headSeq } }, orderBy: { seq: 'asc' }, take: BATCH, select: ROW_SELECT,
    }) as ChainRow[];
    const before = await this.prisma.activityLog.findFirst({ where: { seq: { lte: st.exportedThroughSeq }, chainHash: { not: null } }, orderBy: { seq: 'desc' }, select: { chainHash: true } });
    let prev = st.exportedThroughSeq === 0n ? GENESIS : before?.chainHash ?? GENESIS;
    const lines: ExportLine[] = [];
    for (const r of rows) {
      if (!r.chainHash) break;
      const refs = (r.sealedRefs ?? refsOf(r)) as ReturnType<typeof refsOf>;
      lines.push({ schema: EXPORT_SCHEMA, type: 'entry', seq: r.seq.toString(), hash: r.chainHash, prev, entry: entryOf(r, refs, (r.chainGap as [string, string] | null) ?? null) });
      prev = r.chainHash;
    }
    const through = lines.length ? BigInt((lines[lines.length - 1] as { seq: string }).seq) : st.exportedThroughSeq;
    // A checkpoint is exported once the entries it covers have been.
    const pending = await this.prisma.auditCheckpoint.findMany({ where: { seq: { gt: st.exportedThroughSeq, lte: through } }, orderBy: { seq: 'asc' } });
    for (const c of pending) lines.push({ schema: EXPORT_SCHEMA, type: 'checkpoint', checkpoint: { seq: c.seq.toString(), hash: c.hash, at: c.at.toISOString(), keyId: c.keyId, signature: c.signature } });
    if (!lines.length) return;
    try {
      const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
      if (process.env.AUDIT_EXPORT_FILE) appendFileSync(process.env.AUDIT_EXPORT_FILE, text, { mode: 0o600 });
      if (process.env.AUDIT_EXPORT_URL) await this.post(process.env.AUDIT_EXPORT_URL, text);
      await this.prisma.auditChainState.update({ where: { id: 'chain' }, data: { exportedThroughSeq: through, exportedAt: now, exportError: null } });
    } catch (e) {
      // Not advanced: the same entries go again next pass. A sink must
      // therefore accept a line it already has (same seq, same hash).
      await this.prisma.auditChainState.update({ where: { id: 'chain' }, data: { exportError: (e as Error).message.slice(0, 300) } });
    }
  }

  private async post(url: string, ndjson: string) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) throw new Error('AUDIT_EXPORT_URL must be https (or http to loopback)');
    const r = await fetch(u, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/x-ndjson', ...(process.env.AUDIT_EXPORT_TOKEN ? { authorization: `Bearer ${process.env.AUDIT_EXPORT_TOKEN}` } : {}) },
      body: ndjson,
    });
    if (!r.ok) throw new Error(`export sink answered HTTP ${r.status}`);
  }

  /** Recompute the whole chain and check every checkpoint. */
  async verify(now = new Date()) {
    let st = startState();
    let cursor = 0n;
    for (;;) {
      const rows = await this.prisma.activityLog.findMany({ where: { seq: { gt: cursor }, chainHash: { not: null } }, orderBy: { seq: 'asc' }, take: 2000, select: ROW_SELECT }) as ChainRow[];
      if (!rows.length) break;
      st = verifyRows(st, rows);
      cursor = rows[rows.length - 1].seq;
    }
    const state = await this.state();
    if (st.prevSeq < state.headSeq) st.problems.push({ seq: state.headSeq.toString(), kind: 'deleted', detail: `the chain head is ${state.headSeq} but the last sealed entry is ${st.prevSeq}` });
    else if (st.prevSeq === state.headSeq && st.prevHash !== state.headHash && st.prevSeq > 0n) st.problems.push({ seq: state.headSeq.toString(), kind: 'altered', detail: 'the stored head hash differs from the chain' });
    for (const c of await this.prisma.auditCheckpoint.findMany({ orderBy: { seq: 'asc' } })) {
      const row = await this.prisma.activityLog.findUnique({ where: { seq: c.seq }, select: { chainHash: true } });
      if (!row || row.chainHash !== c.hash) st.problems.push({ seq: c.seq.toString(), kind: 'checkpoint_mismatch', detail: row ? 'the entry no longer has the hash the checkpoint recorded' : 'the entry a checkpoint recorded is gone' });
      if (c.signature && this.key && !checkCheckpoint({ seq: c.seq.toString(), hash: c.hash, at: c.at.toISOString(), keyId: c.keyId, signature: c.signature }, this.key.pub)) {
        st.problems.push({ seq: c.seq.toString(), kind: 'checkpoint_signature', detail: 'a checkpoint signature does not verify with the current key' });
      }
    }
    const ok = st.problems.length === 0;
    const was = (state.verifyResult as { ok?: boolean } | null)?.ok;
    await this.prisma.auditChainState.update({
      where: { id: 'chain' },
      data: { verifiedAt: now, verifiedThroughSeq: st.prevSeq, verifyResult: { ok, checked: st.checked, problems: st.problems.slice(0, 50) } as unknown as Prisma.InputJsonValue },
    });
    if (!ok && was !== false) {
      this.logger.error(`AUDIT CHAIN BROKEN: ${st.problems[0].kind} at seq ${st.problems[0].seq}: ${st.problems[0].detail}`);
      await this.audit.log({ action: 'AUDIT_CHAIN_ALERT', resource: 'audit_chain', meta: { problems: st.problems.slice(0, 5) } });
    }
    return { ok, checked: st.checked, throughSeq: st.prevSeq.toString(), problems: st.problems };
  }

  async status(now = new Date()): Promise<ChainStatus> {
    const st = await this.state();
    const unsealed = await this.prisma.activityLog.count({ where: { seq: { gt: st.headSeq } } });
    const oldest = unsealed ? await this.prisma.activityLog.findFirst({ where: { seq: { gt: st.headSeq } }, orderBy: { seq: 'asc' }, select: { createdAt: true } }) : null;
    const lastExported = st.exportedThroughSeq < st.headSeq
      ? await this.prisma.activityLog.findFirst({ where: { seq: { gt: st.exportedThroughSeq } }, orderBy: { seq: 'asc' }, select: { createdAt: true } }) : null;
    const v = st.verifyResult as { ok?: boolean; checked?: number; problems?: Problem[] } | null;
    const cp = await this.prisma.auditCheckpoint.findFirst({ orderBy: { seq: 'desc' } });
    return {
      headSeq: st.headSeq.toString(), sealedAt: st.sealedAt, unsealed,
      sealLagSeconds: oldest ? Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000) : 0,
      export: {
        configured: this.sinks(), exportedThroughSeq: st.exportedThroughSeq.toString(), exportedAt: st.exportedAt, error: st.exportError,
        lagSeconds: !this.sinks().length ? null : lastExported ? Math.round((now.getTime() - lastExported.createdAt.getTime()) / 1000) : 0,
      },
      verify: { at: st.verifiedAt, throughSeq: st.verifiedThroughSeq.toString(), ok: v?.ok ?? null, problems: v?.problems ?? [], checked: v?.checked ?? 0 },
      checkpoints: { signed: !!this.key, keyId: this.key?.keyId ?? null, last: cp ? { seq: cp.seq.toString(), at: cp.at } : null },
    };
  }
}
