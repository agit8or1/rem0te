import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Single-use markers that survive a restart: request nonces and delegation
 * token ids. `consume` is one INSERT — the primary key does the test-and-set,
 * so two concurrent replays cannot both win (no read-test-write).
 */
@Injectable()
export class ReplayGuardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ReplayGuardService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.prisma.integrationReplayGuard.deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch((e) => this.logger.warn(`replay-guard prune failed: ${e}`));
    }, 10 * 60_000);
    this.timer.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  /** true = first use (now recorded); false = seen before. */
  async consume(key: string, expiresAt: Date, jobId?: string): Promise<boolean> {
    // INSERT … ON CONFLICT DO NOTHING: atomic, and a replay is not an error.
    const r = await this.prisma.integrationReplayGuard.createMany({
      data: [{ key, expiresAt, jobId: jobId ?? null }], skipDuplicates: true,
    });
    return r.count === 1;
  }

  async lookup(key: string) {
    return this.prisma.integrationReplayGuard.findUnique({ where: { key } });
  }

  async attachJob(key: string, jobId: string) {
    await this.prisma.integrationReplayGuard.update({ where: { key }, data: { jobId } });
  }
}
