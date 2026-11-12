import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { metricConfig } from '../metrics/metrics-math';
import {
  RETENTION_TABLES, cutoffs, drain, perPassCap, retentionConfig, sweepEnabled,
  type RetentionConfig, type TableEntry,
} from './retention-policy';

/**
 * Data retention (0.34): one sweep for the tables that grow without bound,
 * in the style of the metric sweep (metrics.service.ts).
 *
 *   every RETENTION_SWEEP_SECONDS (1 h)  → prune each table past its window,
 *                                          RETENTION_BATCH rows per statement,
 *                                          at most RETENTION_BATCHES per table
 *   a pass that removed anything         → one RETENTION_PRUNED audit entry
 *   RETENTION_SWEEP=off                  → no sweep in this process
 *
 * What it never touches (check-security-invariants §33):
 *   - the audit chain. ActivityLog, AuditCheckpoint and AuditChainState are
 *     not named in any statement here; the one audit entry per pass is an
 *     insert through AuditService, which the chain allows;
 *   - anything still open: a PENDING or DISPATCHED command, a diagnostic not
 *     finished, an alert that is OPEN or ACKNOWLEDGED (or an outage alert
 *     with a child that is), a session that has not ended, a token or grant
 *     that has not expired — every statement names the finished states;
 *   - the last result: the newest command of each type per computer, and the
 *     newest that succeeded, at any age; likewise per diagnostic key.
 *
 * Idempotent: each statement deletes by cutoff and state, so a second pass,
 * or a second API process, finds nothing more to do. Alert deletion locks its
 * batch with SKIP LOCKED, so two sweepers do not wait on each other.
 */

const DONE_COMMAND = Prisma.raw(`('SUCCEEDED','FAILED','EXPIRED')`);
const DONE_DIAGNOSTIC = Prisma.raw(`('COMPLETED','FAILED','EXPIRED')`);
const DONE_SESSION = Prisma.raw(`('SESSION_COMPLETED','FAILED','CANCELED','STATUS_UNKNOWN')`);

export type PassCounts = {
  commands: number; diagnostics: number; changes: number; alerts: number; alertEvents: number;
  sessionEventsTrimmed: number; launcherTokens: number; connectionGrants: number; privileged: number;
};

export interface PassResult {
  at: string;
  counts: PassCounts;
  total: number;
  /** Tables that hit the per-pass cap: there is more to do next pass. */
  capped: string[];
  ms: number;
}

const STATUS_CACHE_MS = 60_000;

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Retention');
  private readonly cfg: RetentionConfig = retentionConfig(process.env);
  private readonly enabled = sweepEnabled(process.env);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private last: PassResult | null = null;
  private lastError: { at: string; message: string } | null = null;
  private statusCache: { at: number; data: unknown } | null = null;

  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  onModuleInit() {
    if (!this.enabled) return;
    const every = this.cfg.sweepSeconds * 1000;
    // The first pass waits a little: a restart is not the moment to add load.
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(120_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  get config(): RetentionConfig { return this.cfg; }

  /** One pass over every table. Returns null when a pass is already running or it failed. */
  async sweep(now = new Date()): Promise<PassResult | null> {
    if (this.busy) return null;
    this.busy = true;
    const t0 = Date.now();
    try {
      const counts = await this.prune(now);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const cap = perPassCap(this.cfg);
      const capped = (Object.keys(counts) as (keyof PassCounts)[]).filter((k) => k !== 'alertEvents' && counts[k] >= cap);
      const result: PassResult = { at: now.toISOString(), counts, total, capped, ms: Date.now() - t0 };
      this.last = result;
      if (total > 0) {
        this.logger.log(`pruned ${Object.entries(counts).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}${capped.length ? ` (more due: ${capped.join(', ')})` : ''} in ${result.ms} ms`);
        // One entry per pass that removed anything: an insert into the chain,
        // which is how the chain records it. Never an update of it.
        await this.audit.log({
          action: 'RETENTION_PRUNED', resource: 'retention',
          meta: { counts, capped, windowsDays: this.windows(), perPassCap: cap },
        });
        this.statusCache = null;
      }
      return result;
    } catch (e) {
      this.lastError = { at: now.toISOString(), message: String(e).slice(0, 300) };
      this.logger.warn(`sweep failed: ${String(e)}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  private windows() {
    const c = this.cfg;
    return {
      commands: c.commandDays, diagnostics: c.diagnosticDays, changes: c.changeDays, alerts: c.alertDays,
      sessionDetail: c.sessionDetailDays, tokens: c.tokenDays, privileged: c.privilegedDays,
    };
  }

  /** Every statement is bounded by `n` rows and repeated at most `batches` times per table. */
  async prune(now = new Date()): Promise<PassCounts> {
    const c = cutoffs(now.getTime(), this.cfg);
    const iso = (t: number) => new Date(t).toISOString();
    const n = this.cfg.batch, k = this.cfg.batches;
    const run = (one: () => Promise<number>) => drain(one, n, k);
    const cmd = iso(c.commands), diag = iso(c.diagnostics), chg = iso(c.changes), alr = iso(c.alerts);
    const ses = iso(c.sessionDetail), tok = iso(c.tokens), prv = iso(c.privileged);

    // Finished commands past the window, keeping the newest of each type per
    // computer and the newest that succeeded (the "last result" the tabs show).
    const commands = await run(() => this.prisma.$executeRaw`
      DELETE FROM "EndpointCommand" WHERE "status" IN ${DONE_COMMAND} AND "id" = ANY(ARRAY(
        SELECT c."id" FROM "EndpointCommand" c
        WHERE c."createdAt" < (${cmd}::timestamptz AT TIME ZONE 'UTC') AND c."status" IN ${DONE_COMMAND}
          AND EXISTS (SELECT 1 FROM "EndpointCommand" x WHERE x."endpointId" = c."endpointId" AND x."type" = c."type"
                      AND (x."createdAt", x."id") > (c."createdAt", c."id"))
          AND (c."status" <> 'SUCCEEDED' OR EXISTS (
                SELECT 1 FROM "EndpointCommand" x WHERE x."endpointId" = c."endpointId" AND x."type" = c."type"
                  AND x."status" = 'SUCCEEDED' AND (x."createdAt", x."id") > (c."createdAt", c."id")))
        ORDER BY c."createdAt" LIMIT ${n}))`);

    // Finished diagnostic runs, the same way per diagnostic key.
    const diagnostics = await run(() => this.prisma.$executeRaw`
      DELETE FROM "DiagnosticRun" WHERE "status" IN ${DONE_DIAGNOSTIC} AND "id" = ANY(ARRAY(
        SELECT r."id" FROM "DiagnosticRun" r
        WHERE r."requestedAt" < (${diag}::timestamptz AT TIME ZONE 'UTC') AND r."status" IN ${DONE_DIAGNOSTIC}
          AND EXISTS (SELECT 1 FROM "DiagnosticRun" x WHERE x."endpointId" = r."endpointId" AND x."key" = r."key"
                      AND (x."requestedAt", x."id") > (r."requestedAt", r."id"))
          AND (r."status" <> 'COMPLETED' OR EXISTS (
                SELECT 1 FROM "DiagnosticRun" x WHERE x."endpointId" = r."endpointId" AND x."key" = r."key"
                  AND x."status" = 'COMPLETED' AND (x."requestedAt", x."id") > (r."requestedAt", r."id")))
        ORDER BY r."requestedAt" LIMIT ${n}))`);

    const changes = await run(() => this.prisma.$executeRaw`
      DELETE FROM "EndpointChange" WHERE "id" = ANY(ARRAY(
        SELECT "id" FROM "EndpointChange" WHERE "detectedAt" < (${chg}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "detectedAt" LIMIT ${n}))`);

    // Resolved alerts past the window, with their events, one locked batch at
    // a time. An outage alert whose grouped child is still open stays.
    let alertEvents = 0;
    const alerts = await run(() => this.prisma.$transaction(async (tx) => {
      const ids = (await tx.$queryRaw<{ id: string }[]>`
        SELECT a."id" FROM "MonitorAlert" a
        WHERE a."state" = 'RESOLVED' AND a."resolvedAt" < (${alr}::timestamptz AT TIME ZONE 'UTC')
          AND NOT EXISTS (SELECT 1 FROM "MonitorAlert" k WHERE k."parentId" = a."id" AND k."state" <> 'RESOLVED')
        ORDER BY a."resolvedAt" LIMIT ${n}
        FOR UPDATE OF a SKIP LOCKED`).map((r) => r.id);
      if (!ids.length) return 0;
      alertEvents += await tx.$executeRaw`DELETE FROM "MonitorAlertEvent" WHERE "alertId" = ANY(${ids}::text[])`;
      return tx.$executeRaw`DELETE FROM "MonitorAlert" WHERE "state" = 'RESOLVED' AND "id" = ANY(${ids}::text[])`;
    }));

    // Session rows stay; on finished sessions, old events lose their detail.
    const sessionEventsTrimmed = await run(() => this.prisma.$executeRaw`
      UPDATE "SupportSessionEvent" SET "metadata" = NULL WHERE "metadata" IS NOT NULL AND "id" = ANY(ARRAY(
        SELECT e."id" FROM "SupportSessionEvent" e JOIN "SupportSession" s ON s."id" = e."supportSessionId"
        WHERE e."metadata" IS NOT NULL AND e."timestamp" < (${ses}::timestamptz AT TIME ZONE 'UTC')
          AND s."status"::text IN ${DONE_SESSION}
        ORDER BY e."timestamp" LIMIT ${n}))`);

    // Never used and long expired. A used one is evidence of access (offboarding reads it).
    const launcherTokens = await run(() => this.prisma.$executeRaw`
      DELETE FROM "LauncherToken" WHERE "usedAt" IS NULL AND "id" = ANY(ARRAY(
        SELECT "id" FROM "LauncherToken" WHERE "usedAt" IS NULL AND "expiresAt" < (${tok}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "expiresAt" LIMIT ${n}))`);
    const connectionGrants = await run(() => this.prisma.$executeRaw`
      DELETE FROM "ConnectionGrant" WHERE "usedAt" IS NULL AND "id" = ANY(ARRAY(
        SELECT "id" FROM "ConnectionGrant" WHERE "usedAt" IS NULL AND "expiresAt" < (${tok}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "expiresAt" LIMIT ${n}))`);

    const privileged = await run(() => this.prisma.$executeRaw`
      DELETE FROM "PrivilegedActivity" WHERE "id" = ANY(ARRAY(
        SELECT "id" FROM "PrivilegedActivity" WHERE "at" < (${prv}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY "at" LIMIT ${n}))`);

    return { commands, diagnostics, changes, alerts, alertEvents, sessionEventsTrimmed, launcherTokens, connectionGrants, privileged };
  }

  // ── Status (Settings → System status) ─────────────────────────────────────

  /** Real counts, cached for a minute: count(*) over the audit log is not free. */
  async status(fresh = false) {
    if (!fresh && this.statusCache && Date.now() - this.statusCache.at < STATUS_CACHE_MS) return this.statusCache.data;
    const m = metricConfig(process.env);
    const tables = [];
    for (const t of RETENTION_TABLES) tables.push({ ...t, ...(await this.countOf(t)), windowDays: this.windowDays(t, m) });
    const data = {
      generatedAt: new Date().toISOString(),
      sweep: {
        enabled: this.enabled, everySeconds: this.cfg.sweepSeconds, batch: this.cfg.batch, batches: this.cfg.batches,
        perPassCap: perPassCap(this.cfg), lastPass: this.last, lastError: this.lastError,
      },
      metricSweep: process.env.METRIC_SWEEP !== 'off',
      tables,
    };
    this.statusCache = { at: Date.now(), data };
    return data;
  }

  private windowDays(t: TableEntry, m: ReturnType<typeof metricConfig>): number | null {
    if (t.windowKey) return this.cfg[t.windowKey];
    if (t.key === 'metricRaw') return Math.round((m.rawHours / 24) * 10) / 10;
    if (t.key === 'metricHourly' || t.key === 'metricDisk') return m.hourlyDays;
    return null;
  }

  // Table and column names come only from RETENTION_TABLES (constants), never from a request.
  private async countOf(t: TableEntry): Promise<{ rows: number; oldest: string | null; oldestNote?: string }> {
    const where = t.key === 'sessionEvents' ? 'WHERE "metadata" IS NOT NULL' : '';
    const table = Prisma.raw(`"${t.table}"`), col = Prisma.raw(`"${t.timeColumn}"`);
    const [r] = await this.prisma.$queryRaw<{ n: bigint; oldest: Date | null }[]>`
      SELECT count(*)::bigint AS n, (SELECT min(${col}) FROM ${table} ${Prisma.raw(where)}) AS oldest FROM ${table}`;
    return {
      rows: Number(r?.n ?? 0),
      oldest: r?.oldest ? new Date(r.oldest).toISOString() : null,
      ...(where ? { oldestNote: 'oldest event that still has its detail' } : {}),
    };
  }
}
