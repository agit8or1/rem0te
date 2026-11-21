import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Put, Query, Req, UnauthorizedException, BadRequestException, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { PrismaService } from '../prisma/prisma.service';
import { BackupsService } from './backups.service';
import { BackupIngestService } from './backup-ingest.service';
import { CONTRACT_VERSION, parseFeed } from './model';
import { AuditService } from '../audit/audit.service';
import { PUSH_PER_MINUTE } from './setup';
import { parsePushAuth, secretMatches } from './push-token';

const biz = (q: Record<string, unknown>) => (typeof q.businessId === 'string' && q.businessId ? q.businessId : undefined);

/**
 * The Backups page's reads (0.81). Every read goes through
 * BackupsService.assetWhere (backups:view, scoped). Nothing here starts a
 * backup, a restore, a drill or a failover.
 */
@Controller('backups')
@UseGuards(JwtAuthGuard)
export class BackupsController {
  constructor(private readonly svc: BackupsService) {}

  @Get()
  async overview(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.overview(a, biz(q)) }; }

  @Get('assets/:id')
  async asset(@Actor() a: ActorContext, @Param('id') id: string, @Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.asset(a, id, biz(q)) }; }

  /** RPO/RTO targets: monitoring:configure for the whole business; audited. */
  @Put('objectives')
  @RateLimit(30)
  async objective(@Actor() a: ActorContext, @Body() body: unknown) { return { success: true, data: await this.svc.setObjective(a, body) }; }

  /**
   * 0.82: link an asset to a computer by hand (or mark it as no computer, or
   * hand it back to the provider's report). Scoped (assetWhere, the asset's
   * business, a computer the caller can see) and audited; see linkAsset.
   */
  @Put('assets/:id/link')
  @RateLimit(30)
  async link(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) { return { success: true, data: await this.svc.linkAsset(a, id, body) }; }
}

/**
 * Provider connections (0.81): Platform Admin only (the class guard, before
 * anything is read). Creating one needs fresh authentication (catalog key
 * backup.connection, §62): its reports become a business's backup status and
 * alerts, and a St0r token is a credential. Revoking never asks.
 */
@Controller('backups/connections')
@UseGuards(PlatformAdminGuard)
export class BackupConnectionsController {
  constructor(private readonly svc: BackupsService, private readonly stepUp: StepUpService) {}

  @Get()
  async list(@Query() q: Record<string, unknown>) { return { success: true, data: await this.svc.listConnections(biz(q)) }; }

  @Post()
  @RateLimit(10)
  async create(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'backup.connection', message: 'Confirm it is you to connect a backup provider.' });
    return { success: true, data: await this.svc.createConnection(a, body) };
  }

  /**
   * 0.82: a new push token, shown once; the old one stops working at once.
   * A credential is issued, so it asks for fresh authentication exactly as
   * creating one does (backup.connection).
   */
  @Post(':id/rotate')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async rotate(@Actor() a: ActorContext, @Param('id') id: string, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'backup.connection', message: 'Confirm it is you to issue a new backup push token.' });
    return { success: true, data: await this.svc.rotateConnection(a, id) };
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.svc.revokeConnection(a, id) }; }
}

/**
 * The St0r push (0.81, decision 17: St0r pushes to Rem0te, Rem0te never
 * connects to a St0r host). The contract is docs/st0r-push-contract.md.
 *
 *   POST /backups/push            Authorization: Bearer rbk_<connection>_<secret>
 *   POST /backups/push?dryRun=1   the same, validated and written nowhere (0.82)
 *
 * In order, before anything is written:
 *   1. the header parses as a push token (else 401);
 *   2. the connection it names exists, is a live push connection, and the
 *      SHA-256 of the secret matches its stored hash, compared in constant
 *      time (else the same 401 — an unknown connection and a wrong secret
 *      look alike);
 *   3. the body is a strict feed (model.ts parseFeed; else 400 BAD_FEED).
 * The business is the connection's. The body names none and cannot.
 * Rate-limited per address; the body is capped by the API's 1 MB JSON limit.
 *
 * A dry run takes steps 1 and 2 unchanged, parses the same schema, and
 * writes NOTHING but one audit row (BACKUP_PUSH_DRY_RUN: counts only, never
 * the feed): no provider row, not the connection's last result. It answers
 * 200 with `valid` and the issues, or what the feed would write.
 */
@Controller('backups/push')
export class BackupPushController {
  constructor(private readonly prisma: PrismaService, private readonly ingest: BackupIngestService, private readonly audit: AuditService) {}

  @Post()
  @Public()
  @RateLimit(PUSH_PER_MINUTE)
  @HttpCode(HttpStatus.OK)
  async push(@Headers('authorization') auth: string | undefined, @Body() body: unknown, @Query('dryRun') dryRunQ?: string) {
    const refuse = () => new UnauthorizedException({ code: 'BACKUP_PUSH_UNAUTHORIZED', message: 'Not a valid backup push token.' });
    if (dryRunQ !== undefined && !['1', 'true', '0', 'false'].includes(dryRunQ)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'dryRun is 1 or 0.' });
    const dryRun = dryRunQ === '1' || dryRunQ === 'true';
    const t = parsePushAuth(auth);
    if (!t) throw refuse();
    const conn = await this.prisma.backupConnection.findUnique({ where: { id: t.connectionId } });
    const live = !!conn && conn.transport === 'push' && conn.enabled && !conn.revokedAt;
    if (!secretMatches(t.secret, live ? conn!.pushTokenHash : null) || !live) throw refuse();
    const f = parseFeed(body);
    if (dryRun) {
      const preview = f.ok ? await this.ingest.preview(conn!, f.feed) : null;
      await this.audit.log({
        action: 'BACKUP_PUSH_DRY_RUN', customerId: conn!.customerId, resource: 'backup_connection', resourceId: conn!.id,
        meta: { valid: f.ok, issues: f.ok ? 0 : f.issues.length, warnings: preview?.warnings.length ?? 0, ...(preview ? { wouldWrite: preview.wouldWrite } : {}) },
      });
      return {
        success: true,
        data: f.ok
          ? { dryRun: true, contractVersion: CONTRACT_VERSION, valid: true, issues: [], ...preview! }
          : { dryRun: true, contractVersion: CONTRACT_VERSION, valid: false, issues: f.issues, wouldWrite: null, assets: [], warnings: [] },
      };
    }
    if (!f.ok) {
      await this.ingest.failed(conn!, 'BAD_FEED', new Date(), f.error);
      throw new BadRequestException({ code: 'BAD_FEED', message: f.error });
    }
    return { success: true, data: { contractVersion: CONTRACT_VERSION, ...(await this.ingest.ingest(conn!, f.feed)) } };
  }
}
