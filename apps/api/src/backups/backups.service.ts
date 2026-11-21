import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type BackupConnection } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { sealSecret } from '../common/secret-box';
import { CONNECTION_KINDS, TRANSPORT_OF, type ConnectionKind } from './model';
import { PROVIDERS, PROVIDER_ORDER } from './providers';
import { DRIVERS } from './drivers';
import { newPushToken } from './push-token';
import { assetState, pageState, type AssetFacts } from './state';

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
/** Rows per asset read for the page: enough for the latest job, the last verified restore and the failed drills. */
const PER_ASSET = { jobs: 20, points: 5, drills: 20 } as const;
const MAX_ASSETS = 500;

const CreateConnection = z.object({
  businessId: z.string().regex(ID),
  kind: z.enum(CONNECTION_KINDS),
  /** A pull provider's credential (the stand-in's bearer token). Sealed; never shown again. */
  credential: z.string().min(8).max(512).regex(/^[\x21-\x7e]+$/).optional(),
}).strict();

const ObjectiveInput = z.object({
  businessId: z.string().regex(ID).optional(),
  /** One asset's target; without it, the business default. */
  assetId: z.string().regex(ID).optional(),
  rpoMinutes: z.number().int().min(5).max(525_600).nullable(),
  rtoMinutes: z.number().int().min(5).max(525_600).nullable(),
}).strict();

/**
 * Backups (0.81): the read side, provider connections and RPO/RTO targets.
 *
 *   reads        backups:view, through assetWhere (below), and nothing else
 *   connections  Platform Admin; creating one needs fresh authentication
 *                (catalog key backup.connection) and is audited; revoking
 *                never asks and is audited
 *   targets      monitoring:configure in the business (they are monitor
 *                thresholds), audited with before and after
 *
 * Nothing here reaches a provider: pulls are BackupSyncService's, pushes
 * BackupPushController's, and every provider row is BackupIngestService's.
 */
@Injectable()
export class BackupsService {
  private readonly encKey: string | undefined;
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    config: ConfigService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY');
  }

  /**
   * The one read rule for backup rows (§91). backups:view, then:
   *   - a Platform Admin or Business Owner: the business in scope (a
   *     Platform Admin with none: every business);
   *   - a technician: the grants that carry backups:view — every asset of
   *     the business on a whole-business grant, else only assets linked to
   *     the grant's computers;
   *   - a Business User: only assets linked to a computer they can see
   *     (endpointVisibilityWhere). An unlinked asset (a mailbox, a share) is
   *     not shown to them: nothing they can see vouches for it.
   */
  assetWhere(a: ActorContext, businessId?: string | null): Prisma.BackupProtectedAssetWhereInput {
    const scope = this.acl.resolveScope(a, businessId);
    if (this.acl.isBusinessOwner(a)) return scope ? { customerId: scope } : {};
    const refuse = () => new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Seeing backups needs the backups:view permission.' });
    if (a.technician) {
      const g = a.technician.sources.filter((s) => (s.capabilities as string[]).includes(CAP.BACKUPS_VIEW));
      if (!g.length) throw refuse();
      if (g.some((s) => s.endpointIds === null)) return { customerId: a.technician.businessId };
      return { customerId: a.technician.businessId, endpointId: { in: [...new Set(g.flatMap((s) => s.endpointIds ?? []))] } };
    }
    if (!a.capabilities.includes(CAP.BACKUPS_VIEW)) throw refuse();
    return { customerId: scope ?? undefined, endpoint: this.acl.endpointVisibilityWhere(a, scope) };
  }

  /** May this person set RPO/RTO targets for the business? */
  private mayConfigure(a: ActorContext, businessId: string): boolean {
    if (this.acl.isBusinessOwner(a)) return true;
    if (a.technician) return a.technician.businessId === businessId && a.technician.sources.some((s) => s.endpointIds === null && (s.capabilities as string[]).includes(CAP.MONITORING_CONFIGURE));
    return a.capabilities.includes(CAP.MONITORING_CONFIGURE);
  }

  private connectionView(c: BackupConnection) {
    return {
      id: c.id, businessId: c.customerId, kind: c.kind, label: PROVIDERS[c.kind as ConnectionKind]?.label ?? c.kind, transport: c.transport,
      enabled: c.enabled, lastSyncAt: c.lastSyncAt, lastResult: c.lastResult, createdAt: c.createdAt, revokedAt: c.revokedAt,
      // Never the token or the credential: their last four characters only.
      pushTokenLast4: c.pushTokenLast4, credentialLast4: c.credentialLast4,
    };
  }

  /** The Backups page, for one business (or, for a Platform Admin with none, every business). */
  async overview(a: ActorContext, businessId?: string | null, now = new Date()) {
    const where = this.assetWhere(a, businessId);
    const scope = this.acl.resolveScope(a, businessId);
    const conns = await this.prisma.backupConnection.findMany({ where: { ...(scope ? { customerId: scope } : {}), revokedAt: null }, orderBy: { createdAt: 'asc' } });
    const assets = await this.prisma.backupProtectedAsset.findMany({
      where, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: MAX_ASSETS,
      include: {
        customer: { select: { id: true, name: true } },
        endpoint: { select: { id: true, name: true } },
        connection: { select: { kind: true, lastSyncAt: true } },
        objective: true,
        jobs: { orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: PER_ASSET.jobs },
        recoveryPoints: { orderBy: [{ pointAt: 'desc' }, { id: 'asc' }], take: PER_ASSET.points },
        drills: { orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: PER_ASSET.drills },
      },
    });
    const total = assets.length < MAX_ASSETS ? assets.length : await this.prisma.backupProtectedAsset.count({ where });
    const bizIds = [...new Set(assets.map((x) => x.customerId))];
    const bizObjectives = new Map((await this.prisma.backupObjective.findMany({ where: { customerId: { in: bizIds }, assetId: null } })).map((o) => [o.customerId, o]));
    const rows = assets.map((x) => {
      const facts: AssetFacts = {
        firstSeenAt: x.firstSeenAt, jobs: x.jobs, points: x.recoveryPoints, drills: x.drills,
        objective: x.objective ? { rpoMinutes: x.objective.rpoMinutes, rtoMinutes: x.objective.rtoMinutes } : null,
        businessObjective: bizObjectives.get(x.customerId) ?? null,
      };
      const s = assetState(facts, now);
      return {
        id: x.id, name: x.name, type: x.assetType, business: x.customer, computer: x.endpoint, provider: x.connection.kind,
        providerLastSyncAt: x.connection.lastSyncAt, firstSeenAt: x.firstSeenAt, lastSeenAt: x.lastSeenAt,
        state: s,
        latestPoint: x.recoveryPoints[0] ? { at: x.recoveryPoints[0].pointAt, location: x.recoveryPoints[0].location } : null,
        failedDrills: x.drills.filter((d) => !d.simulated && (d.result === 'failed' || d.result === 'partial')).slice(0, 5)
          .map((d) => ({ id: d.id, at: d.finishedAt ?? d.startedAt, result: d.result, scope: d.scope, target: d.target, failureCode: d.failureCode })),
        simulatedDrills: x.drills.filter((d) => d.simulated).length,
      };
    });
    const may = { configure: scope ? this.mayConfigure(a, scope) : false, connect: a.isPlatformAdmin };
    const state = pageState(conns);
    const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).length;
    return {
      generatedAt: now, state, businessId: scope,
      needs: state === 'requires_setup'
        ? 'No backup provider is connected for this business. A Platform Admin connects one (St0r pushes its status here; Comet is planned). Until then there is nothing to show, and no backup alert can be raised.'
        : state === 'awaiting_data' ? 'A provider is connected but has not reported yet. St0r reports when it next pushes.' : null,
      connections: conns.map((c) => this.connectionView(c)),
      providers: PROVIDER_ORDER.filter((k) => k !== 'standin' || DRIVERS.standin?.available().ok).map((k) => PROVIDERS[k]),
      totals: {
        assets: total, shown: rows.length,
        stale: count((r) => r.state.backup === 'stale'), failing: count((r) => r.state.backup === 'failing'), never: count((r) => r.state.backup === 'never'),
        verified: count((r) => r.state.drill === 'verified'), neverTested: count((r) => r.state.drill === 'never_tested' || r.state.drill === 'simulated_only'),
        drillFailed: count((r) => r.state.drill === 'failed'), rpoExceeded: count((r) => r.state.rpo.exceeded === true), rtoExceeded: count((r) => r.state.rto.exceeded === true),
        unlinked: count((r) => !r.computer),
      },
      objective: scope ? (() => { const o = bizObjectives.get(scope); return o ? { rpoMinutes: o.rpoMinutes, rtoMinutes: o.rtoMinutes } : null; })() : null,
      assets: rows,
      may,
    };
  }

  /** One asset with its recent history. The same read rule. */
  async asset(a: ActorContext, id: string, businessId?: string | null, now = new Date()) {
    if (!ID.test(id)) throw new NotFoundException('Asset not found');
    const x = await this.prisma.backupProtectedAsset.findFirst({
      where: { AND: [{ id }, this.assetWhere(a, businessId)] },
      include: {
        endpoint: { select: { id: true, name: true } }, customer: { select: { id: true, name: true } }, objective: true, connection: { select: { kind: true, lastSyncAt: true } },
        jobs: { orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: 50 },
        recoveryPoints: { orderBy: [{ pointAt: 'desc' }, { id: 'asc' }], take: 50 },
        drills: { orderBy: [{ startedAt: 'desc' }, { id: 'asc' }], take: 20 },
      },
    });
    if (!x) throw new NotFoundException('Asset not found');
    const biz = await this.prisma.backupObjective.findFirst({ where: { customerId: x.customerId, assetId: null } });
    const state = assetState({ firstSeenAt: x.firstSeenAt, jobs: x.jobs, points: x.recoveryPoints, drills: x.drills, objective: x.objective, businessObjective: biz }, now);
    return {
      id: x.id, name: x.name, type: x.assetType, business: x.customer, computer: x.endpoint, provider: x.connection.kind, providerLastSyncAt: x.connection.lastSyncAt, state,
      jobs: x.jobs.map((j) => ({ id: j.id, startedAt: j.startedAt, finishedAt: j.finishedAt, completion: j.completion, integrity: j.integrity, integrityCheckedAt: j.integrityCheckedAt, restoreTest: j.restoreTest, errorCode: j.errorCode, bytes: j.bytes === null ? null : Number(j.bytes) })),
      recoveryPoints: x.recoveryPoints.map((p) => ({ id: p.id, at: p.pointAt, location: p.location, jobId: p.jobId })),
      drills: x.drills.map((d) => ({ id: d.id, startedAt: d.startedAt, finishedAt: d.finishedAt, result: d.result, simulated: d.simulated, validation: d.validation, target: d.target, scope: d.scope, elapsedSeconds: d.elapsedSeconds, recoveryPointAt: d.recoveryPointAt, failureCode: d.failureCode })),
    };
  }

  // ── Connections (Platform Admin; the controller's guard and fresh check come first) ──

  async listConnections(businessId?: string | null) {
    const rows = await this.prisma.backupConnection.findMany({ where: businessId && ID.test(businessId) ? { customerId: businessId } : {}, orderBy: { createdAt: 'desc' }, take: 500 });
    return { connections: rows.map((c) => this.connectionView(c)), providers: PROVIDER_ORDER.map((k) => PROVIDERS[k]) };
  }

  /**
   * Create a connection. St0r: a push token, returned ONCE and stored only as
   * its SHA-256. Pull: only a provider whose driver exists and can run here
   * (in 0.81, the stand-in under NODE_ENV=test); its credential is sealed.
   * Comet is refused (planned, 4.4).
   */
  async createConnection(a: ActorContext, raw: unknown) {
    const d = CreateConnection.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const { businessId, kind } = d.data;
    const biz = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { id: true, tenantId: true } });
    if (!biz) throw new NotFoundException('Business not found');
    const transport = TRANSPORT_OF[kind];
    if (transport === 'pull') {
      const drv = DRIVERS[kind];
      if (!drv) throw new BadRequestException({ code: 'BACKUP_PROVIDER_NOT_AVAILABLE', message: `${PROVIDERS[kind].label} is not available yet: ${PROVIDERS[kind].stateNote}` });
      const av = drv.available();
      if (!av.ok) throw new BadRequestException({ code: 'BACKUP_PROVIDER_NOT_AVAILABLE', message: `${PROVIDERS[kind].label}: ${PROVIDERS[kind].stateNote}` });
      if (!d.data.credential) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'This provider needs its credential.' });
    } else if (d.data.credential) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A push provider takes no credential: Rem0te makes its token.' });
    }
    if (await this.prisma.backupConnection.findFirst({ where: { customerId: businessId, kind, revokedAt: null }, select: { id: true } })) {
      throw new ConflictException({ code: 'BACKUP_CONNECTION_EXISTS', message: 'This business already has a connection to that provider. Revoke it first.' });
    }
    const id = `bkc${randomBytes(12).toString('hex')}`;
    const tok = transport === 'push' ? newPushToken(id) : null;
    // Audited before the row exists: a connection nobody can account for must not.
    await this.audit.logOrFail({
      action: 'BACKUP_CONNECTION_CREATED', tenantId: biz.tenantId, customerId: businessId, actorId: a.userId, actorIp: a.ip,
      resource: 'backup_connection', resourceId: id, meta: { kind, transport, ...(tok ? { tokenLast4: tok.last4 } : {}) },
    });
    try {
      const c = await this.prisma.backupConnection.create({
        data: {
          id, customerId: businessId, kind, transport, enabled: true, createdById: a.userId,
          ...(tok ? { pushTokenHash: tok.hash, pushTokenLast4: tok.last4 } : {}),
          ...(d.data.credential ? { credentialEnc: sealSecret(this.encKey, 'rem0te-backup-credential-v1', d.data.credential), credentialLast4: d.data.credential.slice(-4) } : {}),
        },
      });
      return { connection: this.connectionView(c), ...(tok ? { pushToken: tok.token, shownOnce: true } : {}) };
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException({ code: 'BACKUP_CONNECTION_EXISTS', message: 'This business already has a connection to that provider.' });
      throw e;
    }
  }

  /** Revoke: final. The token hash and credential are dropped; the reported history stays. Never asks for a fresh confirmation. */
  async revokeConnection(a: ActorContext, id: string) {
    if (!ID.test(id)) throw new NotFoundException('Connection not found');
    const c = await this.prisma.backupConnection.findUnique({ where: { id }, include: { customer: { select: { tenantId: true } } } });
    if (!c || c.revokedAt) throw new NotFoundException('Connection not found');
    const r = await this.prisma.backupConnection.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: a.userId, enabled: false, pushTokenHash: null, credentialEnc: null },
    });
    if (!r.count) throw new NotFoundException('Connection not found');
    await this.audit.log({ action: 'BACKUP_CONNECTION_REVOKED', tenantId: c.customer.tenantId, customerId: c.customerId, actorId: a.userId, actorIp: a.ip, resource: 'backup_connection', resourceId: id, meta: { kind: c.kind } });
    return { revoked: true };
  }

  // ── RPO / RTO targets ────────────────────────────────────────────────────

  async setObjective(a: ActorContext, raw: unknown) {
    const d = ObjectiveInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const scope = this.acl.requireScope(a, d.data.businessId);
    if (!this.mayConfigure(a, scope)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Setting backup targets needs the monitoring:configure permission for the whole business.' });
    let assetId: string | null = null;
    if (d.data.assetId) {
      // The asset must be readable by this person AND in this business.
      const x = await this.prisma.backupProtectedAsset.findFirst({ where: { AND: [{ id: d.data.assetId, customerId: scope }, this.assetWhere(a, scope)] }, select: { id: true } });
      if (!x) throw new NotFoundException('Asset not found');
      assetId = x.id;
    }
    const biz = await this.prisma.customer.findUnique({ where: { id: scope }, select: { tenantId: true } });
    if (!biz) throw new NotFoundException('Business not found');
    const before = await this.prisma.backupObjective.findFirst({ where: { customerId: scope, assetId } });
    const clear = d.data.rpoMinutes === null && d.data.rtoMinutes === null;
    if (clear) {
      if (before) await this.prisma.backupObjective.delete({ where: { id: before.id } });
    } else if (before) {
      await this.prisma.backupObjective.update({ where: { id: before.id }, data: { rpoMinutes: d.data.rpoMinutes, rtoMinutes: d.data.rtoMinutes, updatedById: a.userId } });
    } else {
      await this.prisma.backupObjective.create({ data: { customerId: scope, assetId, rpoMinutes: d.data.rpoMinutes, rtoMinutes: d.data.rtoMinutes, updatedById: a.userId } });
    }
    await this.audit.log({
      action: 'BACKUP_OBJECTIVE_SET', tenantId: biz.tenantId, customerId: scope, actorId: a.userId, actorIp: a.ip, resource: 'backup_objective', resourceId: assetId ?? scope,
      meta: { assetId, before: before ? { rpoMinutes: before.rpoMinutes, rtoMinutes: before.rtoMinutes } : null, after: clear ? null : { rpoMinutes: d.data.rpoMinutes, rtoMinutes: d.data.rtoMinutes } },
    });
    return { objective: clear ? null : { rpoMinutes: d.data.rpoMinutes, rtoMinutes: d.data.rtoMinutes }, assetId };
  }
}
