import { Controller, Get, Headers, HttpException, HttpStatus } from '@nestjs/common';
import { timingSafeEqual, createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditChainService } from '../audit/audit-chain.service';
import { SignerClient } from '../actions/signer.client';
import { Public } from '../common/decorators/public.decorator';
import { readVersion } from './version';

/**
 * Health for a monitor OUTSIDE the platform (v0.28; deploy/scripts/
 * rem0te-external-check.py). Without a token: up or down, nothing else.
 * With `x-rem0te-health-token` equal to HEALTH_TOKEN: the database, the audit
 * chain's seal / export / verify lag, active containment, and whether the
 * approval signer answers — counts and ages only, no names or addresses.
 *
 * A compromised portal can lie here. The external check is for the failures
 * that are not an attack (a stuck sealer, a dead export, a stopped signer),
 * and for noticing that the portal stopped answering at all.
 */
@Public()
@Controller('healthz')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly chain: AuditChainService, private readonly signer: SignerClient) {}

  private authorized(token: string | undefined) {
    const want = process.env.HEALTH_TOKEN;
    if (!want || want.length < 24 || !token) return false;
    const a = createHash('sha256').update(token).digest(), b = createHash('sha256').update(want).digest();
    return timingSafeEqual(a, b);
  }

  @Get()
  async health(@Headers('x-rem0te-health-token') token?: string) {
    let db = true;
    try { await this.prisma.$queryRaw`SELECT 1`; } catch { db = false; }
    if (!this.authorized(token)) {
      if (!db) throw new HttpException({ status: 'down' }, HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'ok' };
    }
    const now = new Date();
    const chain = db ? await this.chain.status(now).catch(() => null) : null;
    const pauses = db ? await this.prisma.containmentPause.groupBy({ by: ['scope'], where: { clearedAt: null }, _count: { _all: true } }).catch(() => []) : [];
    let signer: 'not_configured' | 'up' | 'down' = 'not_configured';
    if (this.signer.configured()) { try { signer = (await this.signer.pauses()).status === 200 ? 'up' : 'down'; } catch { signer = 'down'; } }
    const body = {
      status: db && chain && chain.verify.ok !== false ? 'ok' : 'degraded',
      version: readVersion(), at: now.toISOString(), database: db ? 'up' : 'down', signer,
      audit: chain ? {
        headSeq: chain.headSeq, unsealed: chain.unsealed, sealLagSeconds: chain.sealLagSeconds,
        exportConfigured: chain.export.configured.length > 0, exportLagSeconds: chain.export.lagSeconds, exportError: !!chain.export.error,
        verifiedAt: chain.verify.at, verifyOk: chain.verify.ok, checkpointsSigned: chain.checkpoints.signed,
      } : null,
      containment: { global: pauses.find((p) => p.scope === 'GLOBAL')?._count._all ?? 0, business: pauses.find((p) => p.scope === 'BUSINESS')?._count._all ?? 0 },
    };
    if (!db) throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
