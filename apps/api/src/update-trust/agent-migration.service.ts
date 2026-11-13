import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ContainmentService } from '../containment/containment.service';
import { pauseMessage } from '../containment/pause';
import { PublicUrlService } from '../platform/public-url.service';
import { ROLLOUT_OPEN } from '../client-updates/policy';
import type { ActorContext } from '../rbac/access-control.service';
import { UpdateTrustService } from './update-trust.service';
import {
  buildMigrationScript, MIGRATION_NONCE_RE, MIGRATION_UNAVAILABLE, migrationBlock, newMigrationNonce, validPortalHost,
  type MigrationBlock, type MigrationFacts,
} from './agent-migration';

const HOSTNAME_RE = /^[a-zA-Z0-9._-]{1,253}$/;
const OPEN = { completedAt: null, cancelledAt: null } as const;

/**
 * Per-computer migration from the standard agent to the signed agent (0.34).
 * See agent-migration.ts for why this needs a fresh sign-in and a reason but
 * no second person, and for the mode boundary.
 *
 * This service never writes PlatformSettings: a per-computer request never
 * changes the platform's update-trust mode (check-security-invariants §43).
 * Callers check scope and capability; this checks the preconditions, which it
 * re-checks at every heartbeat.
 */
@Injectable()
export class AgentMigrationService {
  private readonly logger = new Logger('AgentMigration');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly updateTrust: UpdateTrustService,
    private readonly containment: ContainmentService,
    private readonly urls: PublicUrlService,
  ) {}

  /**
   * The address a migration script tells the agent to use: the configured
   * https public address when there is one, otherwise the relay host (which is
   * what the legacy heartbeat already talks to). Never a request header.
   */
  async portalHost(): Promise<string | null> {
    const configured = this.urls.apiConfigured();
    if (configured) {
      try {
        const u = new URL(configured);
        if (u.protocol === 'https:' && validPortalHost(u.host)) return u.host;
      } catch { /* fall through */ }
    }
    const s = await this.prisma.tenantSettings.findFirst({ select: { rustdeskRelayHost: true }, orderBy: { createdAt: 'asc' } });
    const relay = s?.rustdeskRelayHost ?? null;
    return relay && HOSTNAME_RE.test(relay) ? relay : null;
  }

  /** Everything migrationBlock() needs about one computer. */
  async facts(endpointId: string): Promise<MigrationFacts | null> {
    const ep = await this.prisma.endpoint.findUnique({
      where: { id: endpointId },
      select: { platform: true, updateChannel: true, status: true, customerId: true, rustdeskNode: { select: { agentSecretHash: true } } },
    });
    if (!ep) return null;
    const [mode, pause, rollout, portalHost] = await Promise.all([
      this.updateTrust.mode(),
      this.containment.blocking('updates', ep.customerId),
      this.prisma.updateJob.findFirst({ where: { endpointId, status: { in: [...ROLLOUT_OPEN] } }, select: { id: true } }),
      this.portalHost(),
    ]);
    return {
      platform: ep.platform, updateChannel: ep.updateChannel, status: ep.status,
      hasSecret: !!ep.rustdeskNode?.agentSecretHash,
      repoConfigured: this.updateTrust.isConfigured(),
      signedAgentPublished: !!this.updateTrust.agentTarget(),
      portalHost,
      mode: mode.mode, legacyPortalMigration: mode.legacyPortalMigration,
      updatesPause: pause ? pauseMessage(pause, 'updates') : null,
      inRollout: !!rollout,
    };
  }

  async block(endpointId: string): Promise<MigrationBlock | null> {
    const f = await this.facts(endpointId);
    return f ? migrationBlock(f) : { code: 'NOT_FOUND', reason: 'Computer not found', fix: null };
  }

  openFor(endpointId: string) {
    return this.prisma.agentMigration.findFirst({ where: { endpointId, ...OPEN } });
  }

  latestFor(endpointId: string) {
    return this.prisma.agentMigration.findFirst({ where: { endpointId }, orderBy: { requestedAt: 'desc' } });
  }

  /**
   * Record a request for one computer. The caller has already checked scope,
   * capability, fresh authentication and the reason. Refuses with the
   * precondition's own code; a second request while one is open is the same
   * request (unchanged), never a second nonce.
   */
  async request(actor: ActorContext, endpointId: string, reason: string, via: 'single' | 'bulk' = 'single') {
    const b = await this.block(endpointId);
    if (b) throw new ConflictException({ code: b.code, message: b.reason });
    const existing = await this.openFor(endpointId);
    if (existing) return { request: existing, unchanged: true };
    const ep = (await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { tenantId: true, customerId: true, agentVersion: true } }))!;
    const agent = this.updateTrust.agentTarget();
    let row;
    try {
      row = await this.prisma.agentMigration.create({
        data: { endpointId, tenantId: ep.tenantId, customerId: ep.customerId, nonce: newMigrationNonce(), reason, requestedById: actor.userId ?? null },
      });
    } catch (e) {
      // The partial unique index: someone else's request landed first.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const open = await this.openFor(endpointId);
        if (open) return { request: open, unchanged: true };
      }
      throw e;
    }
    // The record is the control here (who moved which machine, and why), so
    // a request that cannot be audited is not made.
    try {
      await this.audit.logOrFail({
        tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip,
        action: 'AGENT_MIGRATION_REQUESTED', resource: 'endpoint', resourceId: endpointId,
        meta: { migrationId: row.id, reason, via, fromAgentVersion: ep.agentVersion, signedAgentSha256: agent?.sha256 ?? null, ...(actor.technician ? { viaTechnicianAssignment: true } : {}) },
      });
    } catch (e) {
      await this.prisma.agentMigration.delete({ where: { id: row.id } }).catch(() => undefined);
      throw e;
    }
    return { request: row, unchanged: false };
  }

  /**
   * The automatic migration's request for one computer (0.37,
   * agent-auto-migration). The same precondition function as a person's
   * request, re-checked here at the moment of writing, and the same row — so
   * the same heartbeat hand-out, the same nonce and the same fixed script —
   * with no requester and its rollout named. It is a history row, not an
   * audit entry: one per computer would bury the log, so the rollout's own
   * steps are audited instead (agent-auto-migration.service.ts). Returns null
   * when refused (with the code) or when the computer already has an open
   * request.
   */
  async requestAutomatic(endpointId: string, rolloutId: string, role: 'canary' | 'rollout'): Promise<{ id: string } | { refused: string }> {
    const b = await this.block(endpointId);
    if (b) return { refused: b.code };
    if (await this.openFor(endpointId)) return { refused: 'ALREADY_REQUESTED' };
    const ep = await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { tenantId: true, customerId: true } });
    if (!ep) return { refused: 'NOT_FOUND' };
    try {
      const row = await this.prisma.agentMigration.create({
        data: {
          endpointId, tenantId: ep.tenantId, customerId: ep.customerId, nonce: newMigrationNonce(),
          reason: role === 'canary' ? 'Automatic migration to the signed agent: canary' : 'Automatic migration to the signed agent',
          requestedById: null, automatic: true, rolloutId,
        },
        select: { id: true },
      });
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { refused: 'ALREADY_REQUESTED' };
      throw e;
    }
  }

  /** The automatic migration stopping its own open request (a halted canary). Never a person's request. */
  async cancelAutomatic(migrationId: string): Promise<boolean> {
    const w = await this.prisma.agentMigration.updateMany({ where: { id: migrationId, automatic: true, ...OPEN }, data: { cancelledAt: new Date() } });
    return w.count === 1;
  }

  async cancel(actor: ActorContext, endpointId: string) {
    const open = await this.openFor(endpointId);
    if (!open) return { cancelled: false };
    const w = await this.prisma.agentMigration.updateMany({ where: { id: open.id, ...OPEN }, data: { cancelledAt: new Date(), cancelledById: actor.userId ?? null } });
    if (w.count === 1) {
      await this.audit.log({
        tenantId: open.tenantId ?? undefined, customerId: open.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip,
        action: 'AGENT_MIGRATION_CANCELLED', resource: 'endpoint', resourceId: endpointId,
        meta: { migrationId: open.id, wasDispatched: !!open.dispatchedAt, wasDownloaded: !!open.fetchedAt },
      });
    }
    return { cancelled: w.count === 1 };
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  /**
   * Asked by an AUTHENTICATED heartbeat only. Returns the nonce to hand this
   * computer with the reinstall flag, or null. Only this computer's own open
   * request is ever read, so no other computer can be handed its nonce.
   *
   *   - a signed heartbeat completes the request (the move happened);
   *   - an updates pause, Signed only without portal migration, a staged
   *     rollout or a missing signed agent HOLDS it (recorded, not handed out);
   *   - otherwise it is handed out and the dispatch is recorded first.
   */
  async forHeartbeat(i: { endpointId: string; channel: 'signed' | 'legacy'; updatesHeld: boolean; gate: 'pass' | 'withhold' | 'migrate'; rolloutManaged: boolean }): Promise<{ nonce: string } | null> {
    const open = await this.openFor(i.endpointId);
    if (!open) return null;
    const now = new Date();
    if (i.channel === 'signed') {
      const w = await this.prisma.agentMigration.updateMany({ where: { id: open.id, ...OPEN }, data: { completedAt: now } });
      if (w.count === 1) {
        await this.audit.log({
          tenantId: open.tenantId ?? undefined, customerId: open.customerId ?? undefined,
          action: 'AGENT_MIGRATION_COMPLETED', resource: 'endpoint', resourceId: i.endpointId,
          meta: { migrationId: open.id, dispatchCount: open.dispatchCount },
        });
      }
      return null;
    }
    const hold = i.updatesHeld ? 'contained'
      : i.gate === 'withhold' ? 'signed_only'
        : i.rolloutManaged ? 'rollout'
          : !this.updateTrust.agentTarget() ? 'no_release'
            : null;
    if (hold) {
      if (open.holdReason !== hold || !open.holdAt || now.getTime() - open.holdAt.getTime() > 3600_000) {
        await this.prisma.agentMigration.update({ where: { id: open.id }, data: { holdReason: hold, holdAt: now } }).catch(() => undefined);
      }
      return null;
    }
    await this.prisma.agentMigration.update({
      where: { id: open.id },
      data: { dispatchedAt: open.dispatchedAt ?? now, lastDispatchedAt: now, dispatchCount: { increment: 1 }, holdReason: null, holdAt: null },
    });
    return { nonce: open.nonce };
  }

  /**
   * windows.ps1?updateNonce=<migration nonce>. Null for anything that is not
   * an open migration request (the caller then serves what it always did).
   * Otherwise the migration script pinned to the digest of the signed agent
   * the repository serves NOW — or, where the mode boundary or a missing
   * release forbids it, a script that runs nothing.
   */
  async scriptForNonce(nonce: string): Promise<string | null> {
    if (!MIGRATION_NONCE_RE.test(nonce)) return null;
    const open = await this.prisma.agentMigration.findFirst({ where: { nonce, ...OPEN }, select: { id: true, fetchedAt: true } });
    if (!open) return null;
    const mode = await this.updateTrust.mode();
    const agent = this.updateTrust.agentTarget();
    const host = await this.portalHost();
    const allowed = mode.mode === 'legacy_allowed' || mode.legacyPortalMigration;
    if (!allowed || !agent || !host) return MIGRATION_UNAVAILABLE;
    if (!open.fetchedAt) await this.prisma.agentMigration.update({ where: { id: open.id }, data: { fetchedAt: new Date() } }).catch(() => undefined);
    return buildMigrationScript(host, agent.sha256);
  }
}
