import { Injectable } from '@nestjs/common';
import type { BackupConnection } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { deriveRestoreTests, type FeedAssetT, type FeedT } from './model';

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
 * Nothing here is audited per row: a provider reports every few minutes, and
 * the connection keeps when it last reported and with what result.
 */
@Injectable()
export class BackupIngestService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(conn: BackupConnection, feed: FeedT, now = new Date()): Promise<{ assets: number; jobs: number; points: number; drills: number }> {
    const counts = { assets: 0, jobs: 0, points: 0, drills: 0 };
    for (const a of feed.assets) {
      const n = await this.prisma.$transaction(async (tx) => this.asset(tx as unknown as PrismaService, conn, a, now), { timeout: 30_000 });
      counts.assets++; counts.jobs += n.jobs; counts.points += n.points; counts.drills += n.drills;
    }
    await this.prisma.backupConnection.updateMany({ where: { id: conn.id, revokedAt: null }, data: { lastSyncAt: now, lastResult: 'OK' } });
    return counts;
  }

  /** Record a failed pull (no rows touched). */
  async failed(conn: BackupConnection, code: string, now = new Date()) {
    await this.prisma.backupConnection.updateMany({ where: { id: conn.id, revokedAt: null }, data: { lastResult: code.replace(/[^A-Z0-9_]/g, '_').slice(0, 40) || 'FAILED', updatedAt: now } });
  }

  /** Which of this business's computers the asset is, if it says and that is unambiguous. */
  private async link(db: PrismaService, customerId: string, c: FeedAssetT['computer']): Promise<string | null> {
    if (!c) return null;
    if (c.rem0teId) {
      const e = await db.endpoint.findFirst({ where: { id: c.rem0teId, customerId, status: 'ACTIVE' }, select: { id: true } });
      if (e) return e.id;
    }
    if (c.hostname) {
      const rows = await db.endpoint.findMany({ where: { customerId, status: 'ACTIVE', hostname: { equals: c.hostname, mode: 'insensitive' } }, select: { id: true }, take: 2 });
      if (rows.length === 1) return rows[0].id;
    }
    return null;
  }

  private async asset(db: PrismaService, conn: BackupConnection, a: FeedAssetT, now: Date) {
    const customerId = conn.customerId;
    const endpointId = await this.link(db, customerId, a.computer);
    const asset = await db.backupProtectedAsset.upsert({
      where: { connectionId_externalId: { connectionId: conn.id, externalId: a.externalId } },
      create: { customerId, connectionId: conn.id, externalId: a.externalId, name: a.name, assetType: a.type, endpointId, firstSeenAt: now, lastSeenAt: now },
      update: { name: a.name, assetType: a.type, endpointId, lastSeenAt: now },
    });
    for (const j of a.jobs) {
      const data = {
        startedAt: j.startedAt, finishedAt: j.finishedAt ?? null, completion: j.completion, integrity: j.integrity,
        integrityCheckedAt: j.integrityCheckedAt ?? null, bytes: j.bytes == null ? null : BigInt(j.bytes), errorCode: j.errorCode ?? null,
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
    for (const d of a.drills) {
      const pt = d.recoveryPointExternalId ? pointRows.get(d.recoveryPointExternalId) ?? null : null;
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
    return { jobs: a.jobs.length, points: a.recoveryPoints.length, drills: a.drills.length };
  }
}
