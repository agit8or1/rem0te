import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { activePause } from '../containment/pause';
import { BackupIngestService } from './backup-ingest.service';
import { DRIVERS } from './drivers';
import type { ConnectionKind } from './model';

/** At most this many pull connections are read per pass. */
export const SYNC_PER_PASS = 50;

/**
 * The pull sweep (0.81): every BACKUP_SYNC_SECONDS (default 15 minutes),
 * each enabled pull connection's driver is asked for a feed, which
 * BackupIngestService writes. In 0.81 the only pull driver is the loopback
 * stand-in, so on a production server there is nothing to do: a stand-in
 * connection cannot be created there, and the driver refuses to run.
 *
 * A business under an `integration` containment pause (or a global one) is
 * not asked: a pull is an outbound integration call. A push (St0r) is
 * inbound monitoring data and is accepted during a pause, as monitoring
 * reports are.
 *
 * BACKUP_SYNC_SWEEP=off stops it (exact). run-e2e.sh exports it and
 * e2e-ui.mjs sets it; e2e-backups turns it on, fast, for its own API.
 */
@Injectable()
export class BackupSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('BackupSync');
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly encKey: string | undefined;

  constructor(private readonly prisma: PrismaService, private readonly ingest: BackupIngestService, config: ConfigService) {
    this.encKey = config.get<string>('ENCRYPTION_KEY');
  }

  onModuleInit() {
    if (process.env.BACKUP_SYNC_SWEEP === 'off') return;
    const every = Math.max(2, Number(process.env.BACKUP_SYNC_SECONDS) || 900) * 1000;
    this.timer = setInterval(() => { void this.pass(); }, every);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async pass(now = new Date()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const conns = await this.prisma.backupConnection.findMany({
        where: { transport: 'pull', enabled: true, revokedAt: null },
        orderBy: [{ lastSyncAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }], take: SYNC_PER_PASS,
      });
      for (const c of conns) {
        const drv = DRIVERS[c.kind as ConnectionKind];
        if (!drv) { await this.ingest.failed(c, 'NO_DRIVER', now); continue; }
        if (await activePause(this.prisma, 'integration', c.customerId)) continue;
        try {
          const r = await drv.fetch(c, { encKey: this.encKey });
          if (r.ok) await this.ingest.ingest(c, r.feed, now);
          else await this.ingest.failed(c, r.code, now);
        } catch (e) {
          this.logger.warn(`backup pull ${c.id}: ${(e as Error).message.slice(0, 200)}`);
          await this.ingest.failed(c, 'INGEST_FAILED', now);
        }
      }
    } catch (e) {
      this.logger.error(`backup sync: ${(e as Error).message}`);
    } finally { this.busy = false; }
  }
}
