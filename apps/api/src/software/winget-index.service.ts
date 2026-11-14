import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BROWSE_LETTERS, BROWSE_RANK_CAP, INDEX_DB_ENTRY, INDEX_FETCH_TIMEOUT_MS, INDEX_MAX_DB_BYTES, INDEX_MAX_MSIX_BYTES, INDEX_ROWS_SQL, INDEX_SCHEMA_SQL,
  checkIndexSchema, indexSweepEnabled, indexUrl, installable, nextIndexRead, normalizeIndexRows, pageWindow, rankPage, rankSearch, readZipEntry, refreshDue,
  type BrowseQuery, type BrowseSort, type IndexRow,
} from './winget-index';

const execFileAsync = promisify(execFile);

/**
 * The searchable winget catalog (0.41): a read-only copy of the winget
 * community source's package index, kept in the database and searched by
 * name, id or publisher.
 *
 * Reading it is one bounded GET of a fixed URL (winget-index.ts
 * WINGET_INDEX_URL; a loopback-only override for tests): no credentials, no
 * cookies, no redirects followed, 60 seconds, at most 32 MB. The database in
 * the MSIX is written to a private temporary directory, read with the
 * sqlite3 command-line tool (read-only, two fixed queries, an argument
 * array), and deleted. The rows replace the table in one transaction, so a
 * failed read leaves the previous copy searchable and says why.
 *
 * The sweep reads it at most daily (a failure is retried after an hour);
 * WINGET_INDEX_SWEEP=off stops it in this process. It is not on any
 * heartbeat path: nothing a computer sends reaches this service.
 */
@Injectable()
export class WingetIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WingetIndex');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!indexSweepEnabled()) return;
    this.first = setTimeout(() => { void this.tick(); }, 30_000);
    this.timer = setInterval(() => { void this.tick(); }, 15 * 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  private async state() {
    return this.prisma.wingetIndexState.findUnique({ where: { id: 1 } });
  }

  async status() {
    const s = await this.state();
    return {
      refreshedAt: s?.refreshedAt ?? null, attemptedAt: s?.attemptedAt ?? null, packages: s?.packages ?? 0, skipped: s?.skipped ?? 0,
      sourceWrittenAt: s?.sourceWrittenAt ?? null, sourceSha256: s?.sourceSha256 ?? null, lastError: s?.lastError ?? null,
      sweep: indexSweepEnabled() ? 'on' as const : 'off' as const, refreshing: !!this.running,
      // 0.42: when an empty (or day-old) index will next be read, so the page can say so.
      nextReadAt: nextIndexRead(s ?? null, new Date(), indexSweepEnabled()),
    };
  }

  async tick(now = new Date()) {
    if (this.running) return;
    if (!refreshDue(await this.state(), now)) return;
    await this.refresh(now).catch(() => undefined);
  }

  /** Read the index now (the sweep, or a Platform Admin). One at a time; claims the attempt first. */
  async refresh(now = new Date()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.doRefresh(now).finally(() => { this.running = null; });
    return this.running;
  }

  private async doRefresh(now: Date) {
    await this.prisma.wingetIndexState.upsert({ where: { id: 1 }, create: { id: 1, attemptedAt: now }, update: { attemptedAt: now } });
    let dir: string | null = null;
    try {
      const msix = await this.fetchMsix();
      const db = readZipEntry(msix, INDEX_DB_ENTRY, INDEX_MAX_DB_BYTES);
      dir = mkdtempSync(join(tmpdir(), 'rem0te-winget-'));
      const file = join(dir, 'index.db');
      writeFileSync(file, db, { mode: 0o600 });
      const meta = checkIndexSchema(await this.query(file, INDEX_SCHEMA_SQL));
      const { rows, skipped } = normalizeIndexRows(await this.query(file, INDEX_ROWS_SQL));
      if (!rows.length) throw new Error('the index has no packages');
      await this.prisma.$transaction(async (tx) => {
        await tx.wingetPackage.deleteMany({});
        for (let i = 0; i < rows.length; i += 2000) await tx.wingetPackage.createMany({ data: rows.slice(i, i + 2000) });
        await tx.wingetIndexState.update({
          where: { id: 1 },
          data: { refreshedAt: now, packages: rows.length, skipped, sourceSha256: createHash('sha256').update(msix).digest('hex'), sourceWrittenAt: meta.writtenAt, lastError: null },
        });
      }, { timeout: 120_000 });
      this.log.log(`winget index read: ${rows.length} packages (${skipped} skipped)`);
    } catch (e) {
      const why = ((e as Error).message ?? String(e)).replace(/\s+/g, ' ').slice(0, 300);
      await this.prisma.wingetIndexState.update({ where: { id: 1 }, data: { lastError: why } }).catch(() => undefined);
      this.log.warn(`winget index not read: ${why}`);
      throw e;
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  private async fetchMsix(): Promise<Buffer> {
    let r: Response;
    try {
      r = await fetch(indexUrl(), { method: 'GET', redirect: 'error', credentials: 'omit', headers: { 'user-agent': 'rem0te-software-catalog' }, signal: AbortSignal.timeout(INDEX_FETCH_TIMEOUT_MS) });
    } catch (e) {
      // eslint-disable-next-line preserve-caught-error -- the message is what is stored and shown; the fetch error's own text can carry the URL
      throw new Error(`the winget source did not answer (${(e as Error).name})`);
    }
    if (r.status !== 200 || !r.body) throw new Error(`the winget source answered ${r.status}`);
    const declared = Number(r.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > INDEX_MAX_MSIX_BYTES) { await r.body.cancel().catch(() => undefined); throw new Error('the index is larger than 32 MB; it was not read'); }
    const chunks: Uint8Array[] = [];
    let n = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > INDEX_MAX_MSIX_BYTES) { await reader.cancel().catch(() => undefined); throw new Error('the index is larger than 32 MB; it was not read'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }

  /** One fixed query, read-only, through the sqlite3 tool: an argument array, JSON out. */
  private async query(file: string, sql: string): Promise<unknown> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('sqlite3', ['-readonly', '-json', `file:${file}?mode=ro`, sql], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }));
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      // eslint-disable-next-line preserve-caught-error -- only the code is kept: sqlite3's stderr is not stored or shown
      throw new Error(code === 'ENOENT' ? 'the sqlite3 tool is not installed on this server' : `sqlite3 could not read the index (${String(code ?? 'error')})`);
    }
    if (!stdout.trim()) return [];
    try { return JSON.parse(stdout); } catch { throw new Error('sqlite3 returned something other than JSON'); }
  }

  // ── Search ────────────────────────────────────────────────────────────────

  /** Every term in the id, name, moniker or (normalised) publisher: bound parameters only. */
  private termsWhere(q: string): Prisma.WingetPackageWhereInput[] {
    const terms = q.trim().split(/\s+/).filter(Boolean).slice(0, 4);
    return terms.map((t) => ({ OR: [{ packageId: { contains: t, mode: 'insensitive' as const } }, { name: { contains: t, mode: 'insensitive' as const } }, { moniker: { contains: t, mode: 'insensitive' as const } }, { publisher: { contains: t.toLowerCase().replace(/[^a-z0-9]/g, '') || t, mode: 'insensitive' as const } }] }));
  }

  async search(q: string, limit: number): Promise<(IndexRow & { installable: boolean })[]> {
    const s = q.trim();
    const rows = await this.prisma.wingetPackage.findMany({ where: { AND: this.termsWhere(s) }, take: 500, orderBy: { packageId: 'asc' } });
    return rankSearch(s, rows, limit).map((r) => ({ ...r, installable: installable(r) }));
  }

  /**
   * One page of the index (0.43): narrowed by a query, a publisher and a
   * letter, sorted by name, or by the 0.42 ranking when there is a query
   * whose matches are few enough to rank (BROWSE_RANK_CAP); more than that
   * is listed by name and says so (ranked: false).
   */
  async browse(b: BrowseQuery): Promise<{ rows: (IndexRow & { installable: boolean })[]; total: number; page: number; pages: number; sort: BrowseSort; ranked: boolean }> {
    const where: Prisma.WingetPackageWhereInput = {
      AND: [
        ...(b.q ? this.termsWhere(b.q) : []),
        ...(b.publisher ? [{ publisher: b.publisher }] : []),
        ...(b.letter === '#' ? [{ NOT: { OR: [...BROWSE_LETTERS].map((l) => ({ name: { startsWith: l, mode: 'insensitive' as const } })) } }]
          : b.letter ? [{ name: { startsWith: b.letter, mode: 'insensitive' as const } }] : []),
      ],
    };
    const total = await this.prisma.wingetPackage.count({ where });
    const out = (rows: IndexRow[]) => rows.map((r) => ({ ...r, installable: installable(r) }));
    if (b.sort === 'relevance' && total <= BROWSE_RANK_CAP) {
      const candidates = await this.prisma.wingetPackage.findMany({ where, take: BROWSE_RANK_CAP, orderBy: { packageId: 'asc' } });
      const r = rankPage(b.q, candidates, b.page, b.pageSize);
      return { rows: out(r.rows), total: r.total, page: r.page, pages: r.pages, sort: 'relevance', ranked: true };
    }
    const w = pageWindow(total, b.page, b.pageSize);
    const dir = b.sort === '-name' ? 'desc' as const : 'asc' as const;
    const rows = await this.prisma.wingetPackage.findMany({ where, orderBy: [{ name: dir }, { packageId: dir }], skip: w.skip, take: b.pageSize });
    return { rows: out(rows), total, page: w.page, pages: w.pages, sort: b.sort === 'relevance' ? 'name' : b.sort, ranked: false };
  }

  async lookup(packageId: string): Promise<IndexRow | null> {
    return this.prisma.wingetPackage.findFirst({ where: { packageId: { equals: packageId, mode: 'insensitive' } } });
  }
}
