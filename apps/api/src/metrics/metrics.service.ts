import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import {
  DISK_GAP_MS, HOUR_MS, MINUTE_MS, RANGES, RAW_GAP_MS, diskSamples, findGaps, hourStart, hoursToRoll, lastCompleteHour,
  mergeHourly, metricConfig, parseRange, pruneCutoffs, rollup, round1, sampleFromLive,
  type HourRow, type MetricConfig,
} from './metrics-math';

/**
 * Metric history (0.33): CPU, memory and disk over time.
 *
 *   heartbeat (authenticated)       → recordHeartbeat: one EndpointMetricSample, ≤ 1/min
 *   inventory pass (authenticated)  → recordDisks: one EndpointDiskSample per volume
 *   sweep (every 5 min)             → roll complete hours into EndpointMetricHourly, then prune
 *   GET /endpoints/:id/metrics      → history, scoped and gap-aware
 *
 * Nothing here is written from an unauthenticated request. The two record
 * methods are called only from the heartbeat's authenticated branch and from
 * a command result (which requires the device secret), and take only values
 * those paths have already sanitised (check-security-invariants §30).
 *
 * Monitoring does not read this. The threshold monitors (DISK_FREE, CPU_HIGH,
 * MEMORY_HIGH) evaluate the live sample on EndpointInventory as it arrives;
 * history is what a technician reads afterwards to see how it got there.
 *
 * Two sweepers (two API instances) are safe: the roll-up is an upsert
 * recomputed from raw, and pruning deletes by cutoff. METRIC_SWEEP=off turns
 * the sweep off in a process; recording and reading continue.
 */

/** Per-volume samples: at most one per computer per this long, so an operator's Refresh cannot flood the table. */
const DISK_MIN_INTERVAL_MS = 10 * MINUTE_MS;

type RawRow = { at: Date; cpu: number | null; memory: number | null; disk: number | null };

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('MetricHistory');
  private readonly cfg: MetricConfig = metricConfig(process.env);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;

  constructor(private readonly prisma: PrismaService, private readonly acl: AccessControlService) {}

  onModuleInit() {
    if (process.env.METRIC_SWEEP === 'off') return;
    const every = this.cfg.sweepSeconds * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(60_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); if (this.first) clearTimeout(this.first); }

  get config(): MetricConfig { return this.cfg; }

  // ── Recording ─────────────────────────────────────────────────────────────

  /**
   * One sample from an authenticated heartbeat's sanitised live values.
   * Skipped when the computer already has a sample inside the minimum interval
   * (a device that heartbeats in a loop gets one row a minute, not thousands).
   */
  async recordHeartbeat(endpointId: string, live: Parameters<typeof sampleFromLive>[0], now = new Date()): Promise<boolean> {
    const s = sampleFromLive(live);
    if (!s) return false;
    const recent = await this.prisma.endpointMetricSample.findFirst({
      where: { endpointId, at: { gt: new Date(now.getTime() - this.cfg.minIntervalSeconds * 1000) } },
      select: { at: true },
    });
    if (recent) return false;
    try {
      await this.prisma.endpointMetricSample.create({ data: { endpointId, at: now, ...s } });
      return true;
    } catch (e) {
      // Two heartbeats in the same millisecond: the first one is the sample.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return false;
      throw e;
    }
  }

  /** Each volume's used share from an authenticated inventory pass's sanitised disk list. */
  async recordDisks(endpointId: string, disks: Parameters<typeof diskSamples>[0], now = new Date()): Promise<number> {
    const rows = diskSamples(disks);
    if (!rows.length) return 0;
    const recent = await this.prisma.endpointDiskSample.findFirst({
      where: { endpointId, at: { gt: new Date(now.getTime() - DISK_MIN_INTERVAL_MS) } },
      select: { at: true },
    });
    if (recent) return 0;
    const r = await this.prisma.endpointDiskSample.createMany({
      data: rows.map((d) => ({ endpointId, at: now, drive: d.drive, used: d.used })),
      skipDuplicates: true,
    });
    return r.count;
  }

  // ── Sweep ─────────────────────────────────────────────────────────────────

  /** One pass: roll up, then prune. Bounded (cfg) and idempotent. */
  async sweep(now = new Date()) {
    if (this.busy) return null;
    this.busy = true;
    try {
      const rolled = await this.rollUp(now);
      const pruned = await this.prune(now);
      if (rolled.hours.length || pruned.raw || pruned.hourly || pruned.disk) {
        this.logger.log(`rolled ${rolled.hours.length} hour(s) (${rolled.rows} row(s), ${rolled.full ? 'full scan' : 'after newest'}); pruned raw ${pruned.raw}, hourly ${pruned.hourly}, disk ${pruned.disk}`);
      }
      return { rolled, pruned };
    } catch (e) {
      this.logger.warn(`sweep failed: ${String(e)}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Complete hours that have samples and no roll-up, oldest first, at most
   * rollupHoursPerPass of them. Each is recomputed from raw and upserted, so
   * running a pass twice changes nothing.
   *
   * Finding them has two speeds. Normally only raw newer than the newest
   * rolled hour is looked at — an index range of about an hour of samples,
   * because the heartbeat stamps samples with the server's clock and so only
   * ever adds to the current hour. On a process's first pass and every
   * fullScanPasses after (hourly by default) it anti-joins all of raw against
   * the roll-up instead, which also finds an hour that was skipped (a clock
   * step, a restore). That is the expensive one — about 1.7 s per thousand
   * computers, measured in docs/metric-history.md — hence not every pass.
   */
  private passes = 0;
  async rollUp(now = new Date()) {
    const end = new Date(lastCompleteHour(now.getTime()));
    const endIso = end.toISOString();
    const full = this.passes++ % this.cfg.fullScanPasses === 0;
    let candidates: { h: Date }[];
    if (full) {
      candidates = await this.prisma.$queryRaw<{ h: Date }[]>`
        SELECT DISTINCT date_trunc('hour', s."at") AS h
        FROM "EndpointMetricSample" s
        WHERE s."at" < (${endIso}::timestamptz AT TIME ZONE 'UTC')
          AND NOT EXISTS (
            SELECT 1 FROM "EndpointMetricHourly" x
            WHERE x."endpointId" = s."endpointId" AND x."hour" = date_trunc('hour', s."at"))
        ORDER BY 1
        LIMIT ${this.cfg.rollupHoursPerPass}`;
    } else {
      const wm = await this.prisma.endpointMetricHourly.aggregate({ _max: { hour: true } });
      const after = new Date((wm._max.hour?.getTime() ?? 0) + HOUR_MS).toISOString();
      candidates = await this.prisma.$queryRaw<{ h: Date }[]>`
        SELECT DISTINCT date_trunc('hour', "at") AS h
        FROM "EndpointMetricSample"
        WHERE "at" >= (${after}::timestamptz AT TIME ZONE 'UTC') AND "at" < (${endIso}::timestamptz AT TIME ZONE 'UTC')
        ORDER BY 1
        LIMIT ${this.cfg.rollupHoursPerPass}`;
    }
    // Timestamps without a zone are UTC in this schema; `h` arrives as a Date read as UTC.
    const hours = hoursToRoll(candidates.map((c) => new Date(c.h).getTime()), now.getTime(), this.cfg.rollupHoursPerPass);
    let rows = 0;
    for (const h of hours) {
      const from = new Date(h).toISOString(), to = new Date(h + HOUR_MS).toISOString();
      rows += await this.prisma.$executeRaw`
        INSERT INTO "EndpointMetricHourly"
          ("endpointId", "hour", "samples", "cpuMin", "cpuAvg", "cpuMax", "memoryMin", "memoryAvg", "memoryMax", "diskMin", "diskAvg", "diskMax")
        SELECT "endpointId", date_trunc('hour', "at"), count(*)::int,
               min("cpu"), avg("cpu")::real, max("cpu"),
               min("memory"), avg("memory")::real, max("memory"),
               min("disk"), avg("disk")::real, max("disk")
        FROM "EndpointMetricSample"
        WHERE "at" >= (${from}::timestamptz AT TIME ZONE 'UTC') AND "at" < (${to}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY 1, 2
        ON CONFLICT ("endpointId", "hour") DO UPDATE SET
          "samples" = EXCLUDED."samples",
          "cpuMin" = EXCLUDED."cpuMin", "cpuAvg" = EXCLUDED."cpuAvg", "cpuMax" = EXCLUDED."cpuMax",
          "memoryMin" = EXCLUDED."memoryMin", "memoryAvg" = EXCLUDED."memoryAvg", "memoryMax" = EXCLUDED."memoryMax",
          "diskMin" = EXCLUDED."diskMin", "diskAvg" = EXCLUDED."diskAvg", "diskMax" = EXCLUDED."diskMax"`;
    }
    return { hours: hours.map((h) => new Date(h).toISOString()), rows, full };
  }

  /**
   * Delete past retention, in batches of pruneBatch, at most pruneBatches per
   * table per pass. Raw rows go only once their hour has a roll-up.
   */
  async prune(now = new Date()) {
    const c = pruneCutoffs({ now: now.getTime(), rawHours: this.cfg.rawHours, hourlyDays: this.cfg.hourlyDays });
    const raw = new Date(c.raw).toISOString(), hourly = new Date(c.hourly).toISOString(), disk = new Date(c.disk).toISOString();
    const n = this.cfg.pruneBatch;
    const loop = async (one: () => Promise<number>) => {
      let total = 0;
      for (let i = 0; i < this.cfg.pruneBatches; i++) {
        const k = await one();
        total += k;
        if (k < n) break;
      }
      return total;
    };
    return {
      raw: await loop(() => this.prisma.$executeRaw`
        DELETE FROM "EndpointMetricSample" WHERE ctid = ANY(ARRAY(
          SELECT s.ctid FROM "EndpointMetricSample" s
          WHERE s."at" < (${raw}::timestamptz AT TIME ZONE 'UTC')
            AND EXISTS (SELECT 1 FROM "EndpointMetricHourly" x
                        WHERE x."endpointId" = s."endpointId" AND x."hour" = date_trunc('hour', s."at"))
          LIMIT ${n}))`),
      hourly: await loop(() => this.prisma.$executeRaw`
        DELETE FROM "EndpointMetricHourly" WHERE ctid = ANY(ARRAY(
          SELECT ctid FROM "EndpointMetricHourly" WHERE "hour" < (${hourly}::timestamptz AT TIME ZONE 'UTC') LIMIT ${n}))`),
      disk: await loop(() => this.prisma.$executeRaw`
        DELETE FROM "EndpointDiskSample" WHERE ctid = ANY(ARRAY(
          SELECT ctid FROM "EndpointDiskSample" WHERE "at" < (${disk}::timestamptz AT TIME ZONE 'UTC') LIMIT ${n}))`),
    };
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * GET /endpoints/:id/metrics. The computer must be in the caller's scope
   * (assertEndpointInScope, with the technician grant for computers:view) AND
   * visible to them (endpointVisibilityWhere — a Business User sees only
   * granted and company-wide computers); either failing is the same 404 as an
   * id that does not exist.
   *
   * 24 h is read from raw samples; 7, 30 and 90 days from the hourly roll-up,
   * with the hours the sweep has not rolled yet (the current one, a backlog)
   * computed from raw on the fly. Gaps are returned as intervals and the
   * series simply has no points there.
   */
  async history(actor: ActorContext, endpointId: string, rawRange: unknown, now = new Date()) {
    const range = parseRange(rawRange);
    if (!range) throw new BadRequestException(`range must be one of ${Object.keys(RANGES).join(', ')}`);
    await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_VIEW);
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [this.acl.endpointVisibilityWhere(actor), { id: endpointId }] },
      select: { id: true, createdAt: true },
    });
    if (!ep) throw new NotFoundException('Computer not found');

    const to = now.getTime();
    // Nothing before the computer existed is "offline".
    const from = Math.max(to - RANGES[range].ms, ep.createdAt.getTime());
    const iso = (t: number) => new Date(t).toISOString();
    const retention = { rawHours: this.cfg.rawHours, hourlyDays: this.cfg.hourlyDays };

    const volumes = await this.diskHistory(endpointId, from, to);

    if (RANGES[range].resolution === 'raw') {
      const rows = await this.prisma.endpointMetricSample.findMany({
        where: { endpointId, at: { gte: new Date(from), lte: now } },
        orderBy: { at: 'asc' },
        select: { at: true, cpu: true, memory: true, disk: true },
      });
      const t = rows.map((r) => r.at.getTime());
      return {
        range, resolution: 'raw' as const, from: iso(from), to: iso(to), bucketSeconds: 0, maxGapSeconds: RAW_GAP_MS / 1000, retention,
        series: { t, cpu: rows.map((r) => round1(r.cpu)), memory: rows.map((r) => round1(r.memory)), disk: rows.map((r) => round1(r.disk)) },
        gaps: findGaps(t, { from, to, maxGapMs: RAW_GAP_MS }).map((g) => ({ from: iso(g.from), to: iso(g.to) })),
        disks: volumes,
      };
    }

    const [rolledRows, rawRows] = await Promise.all([
      this.prisma.endpointMetricHourly.findMany({
        where: { endpointId, hour: { gte: new Date(hourStart(from)), lte: now } },
        orderBy: { hour: 'asc' },
      }),
      this.prisma.endpointMetricSample.findMany({
        where: { endpointId, at: { gte: new Date(hourStart(from)), lte: now } },
        orderBy: { at: 'asc' },
        select: { at: true, cpu: true, memory: true, disk: true },
      }),
    ]);
    const rolled: HourRow[] = rolledRows.map((r) => ({ ...r, hour: r.hour.getTime() }));
    const live = rollup((rawRows as RawRow[]).map((r) => ({ ...r, at: r.at.getTime() })));
    const rows = mergeHourly(rolled, live);
    const t = rows.map((r) => r.hour);
    return {
      range, resolution: 'hour' as const, from: iso(from), to: iso(to), bucketSeconds: 3600, maxGapSeconds: 3600, retention,
      series: {
        t,
        samples: rows.map((r) => r.samples),
        cpu: rows.map((r) => round1(r.cpuAvg)), cpuMin: rows.map((r) => round1(r.cpuMin)), cpuMax: rows.map((r) => round1(r.cpuMax)),
        memory: rows.map((r) => round1(r.memoryAvg)), memoryMin: rows.map((r) => round1(r.memoryMin)), memoryMax: rows.map((r) => round1(r.memoryMax)),
        disk: rows.map((r) => round1(r.diskAvg)), diskMin: rows.map((r) => round1(r.diskMin)), diskMax: rows.map((r) => round1(r.diskMax)),
      },
      gaps: findGaps(t, { from: hourStart(from), to, maxGapMs: HOUR_MS, span: HOUR_MS }).map((g) => ({ from: iso(Math.max(g.from, from)), to: iso(g.to) })),
      disks: volumes,
    };
  }

  private async diskHistory(endpointId: string, from: number, to: number) {
    const rows = await this.prisma.endpointDiskSample.findMany({
      where: { endpointId, at: { gte: new Date(from), lte: new Date(to) } },
      orderBy: [{ at: 'asc' }],
      select: { at: true, drive: true, used: true },
      take: 32 * 400, // 90 days at one pass every 6 h is 360 per volume
    });
    const by = new Map<string, { t: number[]; used: (number | null)[] }>();
    for (const r of rows) {
      const v = by.get(r.drive) ?? { t: [], used: [] };
      v.t.push(r.at.getTime()); v.used.push(round1(r.used));
      by.set(r.drive, v);
    }
    const iso = (t: number) => new Date(t).toISOString();
    return {
      maxGapSeconds: DISK_GAP_MS / 1000,
      volumes: [...by.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([drive, v]) => ({
          drive, t: v.t, used: v.used,
          gaps: findGaps(v.t, { from, to, maxGapMs: DISK_GAP_MS }).map((g) => ({ from: iso(g.from), to: iso(g.to) })),
        })),
    };
  }
}
