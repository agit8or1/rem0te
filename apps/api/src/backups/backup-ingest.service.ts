import { Injectable } from '@nestjs/common';
import type { BackupConnection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { deriveRestoreTests, drillRegresses, errorLine, mergeJob, type FeedAssetT, type FeedT } from './model';

export type LinkHow = 'rem0te_id' | 'hostname' | 'none';

/**
 * The ONLY writer of what a backup provider reported (0.81, §91):
 * BackupProtectedAsset, BackupJob, BackupRecoveryPoint and RestoreDrill.
 *
 * Called with a feed that model.ts parseFeed already accepted, and with the
 * connection it belongs to — the connection the push token named, or the one
 * a pull driver fetched for. Every row is written with THAT connection's
 * business; the feed carries none, so a feed cannot write into another
 * business (and migration 0097's triggers refuse it if code ever tried).
 *
 * A job's restoreTest is never taken from the feed (it has no such field):
 * it is derived here from the stored drills (deriveRestoreTests), and the
 * 0097 trigger refuses 'verified' without a passed, non-simulated drill of
 * that job's own recovery point.
 *
 * Re-sending is safe in any order (0.82, docs/st0r-push-contract.md): every
 * item is keyed by its externalId, and a fact never moves backwards
 * (model.ts mergeJob, drillRegresses).
 *
 * Nothing here is audited per row: a provider reports every few minutes, and
 * the connection keeps when it last reported and with what result.
 */
@Injectable()
export class BackupIngestService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(conn: BackupConnection, feed: FeedT, now = new Date()): Promise<{ assets: number; jobs: number; points: number; drills: number; kept: number }> {
    const counts = { assets: 0, jobs: 0, points: 0, drills: 0, kept: 0 };
    for (const a of feed.assets) {
      const n = await this.prisma.$transaction(async (tx) => this.asset(tx as unknown as PrismaService, conn, a, now), { timeout: 30_000 });
      counts.assets++; counts.jobs += n.jobs; counts.points += n.points; counts.drills += n.drills; counts.kept += n.kept;
    }
    await this.prisma.backupConnection.updateMany({ where: { id: conn.id, revokedAt: null }, data: { lastSyncAt: now, lastResult: 'OK' } });
    return counts;
  }

  /**
   * Record a refused push or a failed pull (no provider row touched).
   * `detail` is Rem0te's own message (a parse error's paths and rules), kept
   * on the connection for Settings → Backups.
   */
  async failed(conn: BackupConnection, code: string, now = new Date(), detail?: string) {
    await this.prisma.backupConnection.updateMany({
      where: { id: conn.id, revokedAt: null },
      data: { lastResult: code.replace(/[^A-Z0-9_]/g, '_').slice(0, 40) || 'FAILED', lastErrorAt: now, lastError: errorLine(detail ?? code), updatedAt: now },
    });
  }

  /**
   * A dry run (0.82, POST /backups/push?dryRun=1): what this feed WOULD do,
   * read-only. For each asset, whether Rem0te already holds it and how it
   * would be linked (by Rem0te id, by hostname, by a person's choice, or not
   * at all) — never which computer — and warnings a provider can act on.
   * Nothing is written here; the controller writes the one audit row.
   */
  async preview(conn: BackupConnection, feed: FeedT) {
    const customerId = conn.customerId;
    const held = new Map((await this.prisma.backupProtectedAsset.findMany({
      where: { connectionId: conn.id, externalId: { in: feed.assets.map((a) => a.externalId) } },
      select: { id: true, externalId: true, linkSource: true, endpointId: true },
    })).map((x) => [x.externalId, x]));
    const assets: { externalId: string; known: boolean; link: LinkHow | 'manual' | 'not_a_computer' }[] = [];
    const warnings: string[] = [];
    for (const a of feed.assets) {
      const h = held.get(a.externalId);
      let link: (typeof assets)[number]['link'];
      if (h?.linkSource === 'none') link = 'not_a_computer';
      else if (h?.linkSource === 'manual' && h.endpointId) link = 'manual';
      else link = (await this.linkHow(this.prisma, customerId, a.computer)).how;
      assets.push({ externalId: a.externalId, known: !!h, link });
      if (link === 'none' && a.computer) {
        warnings.push(`asset ${a.externalId}: names a computer, but none of this business's computers matches (a Rem0te id of this business, or a hostname matching exactly one)`);
      }
      const feedPoints = new Set(a.recoveryPoints.map((p) => p.externalId));
      const feedJobs = new Set(a.jobs.map((j) => j.externalId));
      const storedPoints = h ? new Set((await this.prisma.backupRecoveryPoint.findMany({ where: { assetId: h.id }, select: { externalId: true } })).map((p) => p.externalId)) : new Set<string>();
      const storedJobs = h ? new Set((await this.prisma.backupJob.findMany({ where: { assetId: h.id }, select: { externalId: true } })).map((j) => j.externalId)) : new Set<string>();
      for (const d of a.drills) {
        if (!feedPoints.has(d.recoveryPointExternalId) && !storedPoints.has(d.recoveryPointExternalId)) {
          warnings.push(`asset ${a.externalId} drill ${d.externalId}: recovery point ${d.recoveryPointExternalId} is neither in this feed nor stored; the drill is kept but verifies nothing`);
        }
        if (d.simulated) warnings.push(`asset ${a.externalId} drill ${d.externalId}: simulated, so it is shown and never counts as a verified restore`);
      }
      for (const p of a.recoveryPoints) {
        if (p.jobExternalId && !feedJobs.has(p.jobExternalId) && !storedJobs.has(p.jobExternalId)) {
          warnings.push(`asset ${a.externalId} point ${p.externalId}: job ${p.jobExternalId} is neither in this feed nor stored; the point is kept without a job, so a drill of it verifies no job`);
        }
      }
    }
    const n = (k: 'jobs' | 'recoveryPoints' | 'drills') => feed.assets.reduce((s, a) => s + a[k].length, 0);
    return {
      wouldWrite: { assets: feed.assets.length, jobs: n('jobs'), points: n('recoveryPoints'), drills: n('drills') },
      assets, warnings: warnings.slice(0, 50),
    };
  }

  /**
   * Link an asset to a computer by hand (0.82, the Backups page). The ONE
   * asset write outside a report: it changes only endpointId and the link
   * columns, on an asset the caller (BackupsService.linkAsset) already found
   * through assetWhere, to a computer it already checked is in the asset's
   * business and visible to them. 0097's trigger checks the business again.
   */
  async setLink(assetId: string, customerId: string, to: { source: 'auto' | 'manual' | 'none'; endpointId: string | null; by: string }, now = new Date()) {
    return this.prisma.backupProtectedAsset.updateMany({
      where: { id: assetId, customerId },
      data: to.source === 'auto'
        ? { linkSource: 'auto', endpointId: null, linkedById: null, linkedAt: null }
        : { linkSource: to.source, endpointId: to.source === 'none' ? null : to.endpointId, linkedById: to.by, linkedAt: now },
    });
  }

  /** Which of this business's computers the asset is, if it says and that is unambiguous. */
  private async link(db: PrismaService, customerId: string, c: FeedAssetT['computer']): Promise<string | null> {
    return (await this.linkHow(db, customerId, c)).endpointId;
  }

  private async linkHow(db: PrismaService, customerId: string, c: FeedAssetT['computer']): Promise<{ endpointId: string | null; how: LinkHow }> {
    if (!c) return { endpointId: null, how: 'none' };
    if (c.rem0teId) {
      const e = await db.endpoint.findFirst({ where: { id: c.rem0teId, customerId, status: 'ACTIVE' }, select: { id: true } });
      if (e) return { endpointId: e.id, how: 'rem0te_id' };
    }
    if (c.hostname) {
      const rows = await db.endpoint.findMany({ where: { customerId, status: 'ACTIVE', hostname: { equals: c.hostname, mode: 'insensitive' } }, select: { id: true }, take: 2 });
      if (rows.length === 1) return { endpointId: rows[0].id, how: 'hostname' };
    }
    return { endpointId: null, how: 'none' };
  }

  private async asset(db: PrismaService, conn: BackupConnection, a: FeedAssetT, now: Date) {
    const customerId = conn.customerId;
    // A person's link (0.82) outlives every report: 'manual' keeps its
    // computer, 'none' stays unlinked. A manual link whose computer is gone
    // (deleted) goes back to automatic.
    const held = await db.backupProtectedAsset.findUnique({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: a.externalId } }, select: { linkSource: true, endpointId: true },
    });
    const personal = !!held && (held.linkSource === 'none' || (held.linkSource === 'manual' && !!held.endpointId));
    const endpointId = personal ? held!.endpointId : await this.link(db, customerId, a.computer);
    const linkReset = held && !personal && held.linkSource !== 'auto' ? { linkSource: 'auto', linkedById: null, linkedAt: null } : {};
    const asset = await db.backupProtectedAsset.upsert({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: a.externalId } },
      create: { customerId, connectionId: conn.id, externalId: a.externalId, name: a.name, assetType: a.type, endpointId, firstSeenAt: now, lastSeenAt: now },
      update: { name: a.name, assetType: a.type, ...(personal ? {} : { endpointId, ...linkReset }), lastSeenAt: now },
    });
    let kept = 0;
    const storedJobs = new Map((await db.backupJob.findMany({
      where: { assetId: asset.id, externalId: { in: a.jobs.map((j) => j.externalId) } },
      select: { externalId: true, completion: true, finishedAt: true, integrity: true, integrityCheckedAt: true },
    })).map((r) => [r.externalId, r]));
    for (const j of a.jobs) {
      const m = mergeJob(storedJobs.get(j.externalId) ?? null, { completion: j.completion, finishedAt: j.finishedAt ?? null, integrity: j.integrity, integrityCheckedAt: j.integrityCheckedAt ?? null });
      if (m.regressed.length) kept++;
      const data = {
        startedAt: j.startedAt, finishedAt: m.facts.finishedAt, completion: m.facts.completion, integrity: m.facts.integrity,
        integrityCheckedAt: m.facts.integrityCheckedAt, bytes: j.bytes == null ? null : BigInt(j.bytes), errorCode: j.errorCode ?? null,
      };
      await db.backupJob.upsert({
        where: { assetId_externalId: { assetId: asset.id, externalId: j.externalId } },
        create: { customerId, assetId: asset.id, externalId: j.externalId, ...data },
        update: data,
      });
    }
    const jobIds = new Map((await db.backupJob.findMany({ where: { assetId: asset.id }, select: { id: true, externalId: true } })).map((r) => [r.externalId, r.id]));
    for (const p of a.recoveryPoints) {
      const data = { pointAt: p.pointAt, location: p.location, jobId: p.jobExternalId ? jobIds.get(p.jobExternalId) ?? null : null };
      await db.backupRecoveryPoint.upsert({
        where: { assetId_externalId: { assetId: asset.id, externalId: p.externalId } },
        create: { customerId, assetId: asset.id, externalId: p.externalId, ...data },
        update: data,
      });
    }
    const pointRows = new Map((await db.backupRecoveryPoint.findMany({ where: { assetId: asset.id }, select: { id: true, externalId: true, pointAt: true } })).map((r) => [r.externalId, r]));
    const storedDrills = new Map((await db.restoreDrill.findMany({
      where: { assetId: asset.id, externalId: { in: a.drills.map((d) => d.externalId) } }, select: { externalId: true, result: true, finishedAt: true },
    })).map((r) => [r.externalId, r]));
    for (const d of a.drills) {
      if (drillRegresses(storedDrills.get(d.externalId) ?? null, { result: d.result, finishedAt: d.finishedAt ?? null })) { kept++; continue; }
      const pt = pointRows.get(d.recoveryPointExternalId) ?? null;
      const data = {
        recoveryPointId: pt?.id ?? null,
        // The point's own time when the drill names a stored point; else what the provider said.
        recoveryPointAt: pt?.pointAt ?? d.recoveryPointAt ?? null, target: d.target, scope: d.scope, result: d.result, simulated: d.simulated,
        validation: d.validation, startedAt: d.startedAt, finishedAt: d.finishedAt ?? null, elapsedSeconds: d.elapsedSeconds ?? null, failureCode: d.failureCode ?? null,
      };
      await db.restoreDrill.upsert({
        where: { assetId_externalId: { assetId: asset.id, externalId: d.externalId } },
        create: { customerId, assetId: asset.id, externalId: d.externalId, ...data },
        update: data,
      });
    }
    // restoreTest for every job of this asset, from its own points' drills.
    const [jobs, points, drills] = await Promise.all([
      db.backupJob.findMany({ where: { assetId: asset.id }, select: { id: true, restoreTest: true, restoreDrillId: true } }),
      db.backupRecoveryPoint.findMany({ where: { assetId: asset.id }, select: { id: true, jobId: true } }),
      db.restoreDrill.findMany({ where: { assetId: asset.id }, select: { id: true, recoveryPointId: true, result: true, simulated: true, finishedAt: true, startedAt: true } }),
    ]);
    const decided = deriveRestoreTests(jobs.map((j) => j.id), points, drills);
    for (const j of jobs) {
      const d = decided.get(j.id)!;
      if (d.restoreTest !== j.restoreTest || d.drillId !== j.restoreDrillId) {
        await db.backupJob.update({ where: { id: j.id }, data: { restoreTest: d.restoreTest, restoreDrillId: d.drillId } });
      }
    }
    return { jobs: a.jobs.length, points: a.recoveryPoints.length, drills: a.drills.length, kept };
  }
}
