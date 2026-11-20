import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { EndpointsService } from '../endpoints/endpoints.service';
import { activePause } from '../containment/pause';
import { runsSignedAgent } from '../common/agent-identity';
import { isWindowsPlatform } from '../common/platform';
import { assertAssigned } from '../common/unassigned';
import { ENTITY_ID_RE } from './grant';
import { MsaService } from './msa.service';
import { MsaGrantService } from './msa-grant.service';
import { msaGrantsEnabled, MSA_NOT_ENABLED } from './msa-grants-flag';
import { compareVersion, MIN_ENFORCING_AGENT } from './readiness';
import { MANAGED_CEILING, ReportBody, type ManagedState, type Report } from './managed';

/** The outcomes that mean the agent could not ENFORCE (as opposed to refusing a grant it should refuse). */
const ENFORCEMENT_OUTCOMES = new Set(['readback_mismatch', 'password_not_applied', 'save_failed', 'stop_failed']);

/**
 * Managed Secure Access cutover, enforcement reports, the managed test
 * session and rollback (0.72, build step 4), behind MSA_GRANTS.
 *
 * The only writer of MsaManagedComputer (§82). Every public method asserts
 * the switch first. A computer moves only when a Platform Admin moves that
 * ONE computer (cutover, confirm, rollback — the controller requires the
 * Platform Admin and the fresh confirmations), or when its own signed agent
 * reports what it did (report, device secret first). Nothing here moves a
 * group, a business or the fleet, and nothing moves a computer by itself.
 */
@Injectable()
export class MsaManagedService {
  private readonly logger = new Logger('MsaManaged');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly enrollment: EnrollmentService,
    private readonly endpoints: EndpointsService,
    private readonly msa: MsaService,
    private readonly grants: MsaGrantService,
  ) {}

  private assertEnabled() {
    if (!msaGrantsEnabled()) throw new NotFoundException({ code: MSA_NOT_ENABLED, message: 'Managed Secure Access grants are not enabled on this server.' });
  }

  /** A computer this person can see, assigned, Windows and the signed agent: the shared front of every console route. */
  private async computer(actor: ActorContext, endpointId: string) {
    if (!ENTITY_ID_RE.test(endpointId)) throw new NotFoundException('Computer not found');
    await this.acl.assertEndpointInScope(actor, endpointId, 'computers:view');
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [{ id: endpointId }, this.acl.endpointVisibilityWhere(actor)] },
      select: { id: true, tenantId: true, customerId: true, platform: true, updateChannel: true, signedSeenAt: true },
    });
    if (!ep) throw new NotFoundException('Computer not found');
    return ep;
  }

  private row(endpointId: string) {
    return this.prisma.msaManagedComputer.findUnique({ where: { endpointId } });
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /**
   * The device card's managed view (View computers, in scope): the managed
   * state, the latest grants (never a password or envelope), whether the
   * grant key is published, and — when Legacy — whether cutover would be
   * allowed and why not. The controls are a Platform Admin's; the card shows
   * them only to one.
   */
  async view(actor: ActorContext, endpointId: string) {
    this.assertEnabled();
    const ep = await this.computer(actor, endpointId);
    const row = await this.row(ep.id);
    const grants = await this.grants.listForEndpoint(actor, ep.id);
    const keyId = await this.grants.activePublishedKeyId();
    const blockers = row ? [] : await this.cutoverBlockers(ep);
    return {
      enabled: true,
      endpointId: ep.id,
      state: (row?.state ?? 'legacy') as ManagedState | 'legacy',
      managed: row ? {
        state: row.state, requestedAt: row.requestedAt, verifiedAt: row.verifiedAt, legacySecuredAt: row.legacySecuredAt,
        failedAt: row.failedAt, failReason: row.failReason, failedKeys: row.failedKeys, rollbackRequestedAt: row.rollbackRequestedAt,
        readbackOkAt: row.readbackOkAt, lastReportAt: row.lastReportAt,
      } : null,
      grants: grants.slice(0, 5),
      grantKeyPublished: !!keyId,
      ceiling: MANAGED_CEILING,
      cutover: { allowed: !row && blockers.length === 0, blockers },
      canConfirm: !!row && row.state === 'pending' && (await this.testSessionConnected(ep.id, row.requestedAt)),
      evidence: 'Managed Secure Access has run only in the Windows lab (Windows Server, no signed-in user, no live session): never on a Windows 10 or 11 desktop or on the fleet.',
    };
  }

  /** Why cutover would be refused now, as codes with sentences. Empty means allowed. */
  private async cutoverBlockers(ep: { id: string; customerId: string | null; tenantId: string | null; platform: string | null; updateChannel: string | null; signedSeenAt: Date | null }) {
    const out: { code: string; message: string }[] = [];
    if (!ep.customerId || !ep.tenantId) out.push({ code: 'ENDPOINT_UNASSIGNED', message: 'The computer is in the unassigned pool.' });
    if (!isWindowsPlatform(ep.platform) || !runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt })) {
      out.push({ code: 'MSA_SIGNED_AGENT_REQUIRED', message: 'Managed Secure Access needs a Windows computer running the signed agent.' });
    }
    const pr = await this.msa.preflightReadiness(ep.id);
    if (!pr || pr.readiness.state !== 'compatible') {
      out.push({ code: 'MSA_NOT_COMPATIBLE', message: `Readiness is ${pr?.readiness.label ?? 'unknown'}, not Compatible.` });
    }
    const v = compareVersion(pr?.agentVersion ?? null, MIN_ENFORCING_AGENT);
    if (v === null || v < 0) out.push({ code: 'MSA_AGENT_TOO_OLD', message: `The signed agent must be ${MIN_ENFORCING_AGENT} or later to enforce a grant.` });
    if (ep.customerId && (await activePause(this.prisma, 'remote', ep.customerId))) out.push({ code: 'CONTAINED', message: 'Remote connections are paused for this computer.' });
    if (!(await this.grants.activePublishedKeyId())) {
      out.push({ code: 'MSA_GRANT_KEY_NOT_PUBLISHED', message: 'The grant key is not in the signed release metadata yet (Settings shows the two commands to run on the release host).' });
    }
    return out;
  }

  private async testSessionConnected(endpointId: string, since: Date) {
    return (await this.prisma.msaGrant.count({
      where: { endpointId, createdAt: { gte: since }, connectedAt: { not: null }, state: { in: ['applied', 'ended'] } },
    })) > 0;
  }

  // ── Cutover, confirmation, rollback (Platform Admin, one computer) ────────

  /**
   * Move ONE computer from Legacy into Managed (pending). The controller has
   * required a Platform Admin and a fresh confirmation (msa.cutover). Then:
   * scope, every cutover blocker (pool, signed Windows agent, readiness
   * Compatible, an enforcing agent, no `remote` pause, a published grant
   * key), not already managed, the audit row (logOrFail), the row. Nothing
   * changes on the computer yet: Legacy keeps working until a test session
   * succeeds and a Platform Admin confirms it.
   */
  async cutover(actor: ActorContext, endpointId: string, runId: string | null = null) {
    this.assertEnabled();
    const ep = await this.computer(actor, endpointId);
    assertAssigned(ep);
    if (await this.row(ep.id)) throw new ConflictException({ code: 'MSA_ALREADY_MANAGED', message: 'This computer is already in Managed Secure Access.' });
    const blockers = await this.cutoverBlockers(ep);
    if (blockers.length) {
      const first = blockers[0];
      if (first.code === 'CONTAINED') throw new ForbiddenException({ code: 'CONTAINED', message: `${first.message} Nothing was changed.` });
      throw new ConflictException({ code: first.code, message: `${first.message} Nothing was changed.`, blockers });
    }
    await this.audit.logOrFail({
      action: 'MSA_CUTOVER', actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: ep.id, meta: { endpointId: ep.id, before: 'legacy', after: 'pending', ...(runId ? { runId } : {}) },
    });
    try {
      await this.prisma.msaManagedComputer.create({ data: { endpointId: ep.id, state: 'pending', requestedById: actor.userId, runId } });
    } catch {
      throw new ConflictException({ code: 'MSA_ALREADY_MANAGED', message: 'This computer is already in Managed Secure Access.' });
    }
    return this.view(actor, ep.id);
  }

  /**
   * Confirm a Managed (pending) computer verified: only after a managed test
   * session on it since cutover was applied (every setting read back) AND
   * the agent saw a RustDesk connection. Platform Admin, fresh confirmation
   * (msa.cutover), audited. The agent, told `verified` on its next poll,
   * replaces the legacy permanent password with one nobody is told and
   * reports `secured`; from then on legacy Connect and Reveal refuse it.
   */
  async confirm(actor: ActorContext, endpointId: string) {
    this.assertEnabled();
    const ep = await this.computer(actor, endpointId);
    const row = await this.row(ep.id);
    if (!row) throw new ConflictException({ code: 'MSA_NOT_MANAGED', message: 'This computer is in Legacy mode.' });
    if (row.state !== 'pending') throw new ConflictException({ code: 'MSA_NOT_PENDING', message: 'Only a computer in Managed (pending) can be confirmed.' });
    if (!row.readbackOkAt || !(await this.testSessionConnected(ep.id, row.requestedAt))) {
      throw new ConflictException({ code: 'MSA_NO_TEST_SESSION', message: 'Confirm only after a managed test session: a test grant the agent applied and read back, and a RustDesk connection it saw.' });
    }
    await this.audit.logOrFail({
      action: 'MSA_VERIFIED', actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: ep.id, meta: { endpointId: ep.id, before: 'pending', after: 'verified' },
    });
    const moved = await this.prisma.msaManagedComputer.updateMany({
      where: { endpointId: ep.id, state: 'pending' }, data: { state: 'verified', verifiedAt: new Date(), verifiedById: actor.userId },
    });
    if (moved.count !== 1) throw new ConflictException({ code: 'MSA_NOT_PENDING', message: 'Only a computer in Managed (pending) can be confirmed.' });
    this.grants.wake(ep.id);
    return this.view(actor, ep.id);
  }

  /**
   * 0.73: confirm a computer a cutover run moved, without a connection: the
   * run's canary already proved a connection through a managed session (it
   * was confirmed the ordinary way), so each later computer needs only its
   * own agent's apply and readback of the run's verification grant since it
   * was cut over. Platform Admin (the run controller), msa.cutover, audited.
   * MsaCutoverRunService is the only caller.
   */
  async confirmFromRun(actor: ActorContext, endpointId: string, runId: string) {
    this.assertEnabled();
    const ep = await this.computer(actor, endpointId);
    const row = await this.row(ep.id);
    if (!row || row.state !== 'pending' || row.runId !== runId) return false;
    const applied = await this.prisma.msaGrant.count({
      where: { endpointId: ep.id, source: 'verify', createdAt: { gte: row.requestedAt }, appliedAt: { not: null } },
    });
    if (!row.readbackOkAt || row.readbackOkAt < row.requestedAt || applied === 0) return false;
    await this.audit.logOrFail({
      action: 'MSA_VERIFIED', actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
      resource: 'endpoint', resourceId: ep.id, meta: { endpointId: ep.id, before: 'pending', after: 'verified', runId },
    });
    const moved = await this.prisma.msaManagedComputer.updateMany({
      where: { endpointId: ep.id, state: 'pending', runId }, data: { state: 'verified', verifiedAt: new Date(), verifiedById: actor.userId },
    });
    if (moved.count === 1) this.grants.wake(ep.id);
    return moved.count === 1;
  }

  /**
   * Roll ONE computer back to Legacy. Platform Admin, never a fresh
   * confirmation: it only reduces what Managed Secure Access holds. It stages
   * a fresh sealed permanent password through the existing rotation path
   * (held by the heartbeat until the agent has restored RustDesk's settings),
   * cancels grants not yet delivered, and tells the agent to end any session
   * and restore the settings it saved before its first apply. The row goes
   * when the agent reports `restored`. With `force`, a computer already
   * rolling back is returned to Legacy without the agent (it may never
   * report again); its RustDesk keeps whatever settings it has, and the
   * staged rotation gives the portal a password that works.
   */
  async rollback(actor: ActorContext, endpointId: string, force: boolean) {
    this.assertEnabled();
    const ep = await this.computer(actor, endpointId);
    const row = await this.row(ep.id);
    if (!row) throw new ConflictException({ code: 'MSA_NOT_MANAGED', message: 'This computer is already in Legacy mode.' });
    const base = { actorId: actor.userId, actorIp: actor.ip, tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined, resource: 'endpoint', resourceId: ep.id };
    if (row.state === 'rollback_pending') {
      if (!force) throw new ConflictException({ code: 'MSA_ROLLBACK_PENDING', message: 'This computer is already rolling back; it finishes when the agent reports. Force it only if the agent will not report again.' });
      await this.audit.logOrFail({ ...base, action: 'MSA_ROLLED_BACK', meta: { endpointId: ep.id, before: 'rollback_pending', after: 'legacy', forced: true } });
      await this.prisma.msaManagedComputer.deleteMany({ where: { endpointId: ep.id, state: 'rollback_pending' } });
      return this.view(actor, ep.id);
    }
    await this.audit.logOrFail({ ...base, action: 'MSA_ROLLBACK_REQUESTED', meta: { endpointId: ep.id, before: row.state, after: 'rollback_pending' } });
    const moved = await this.prisma.msaManagedComputer.updateMany({
      where: { endpointId: ep.id, state: row.state }, data: { state: 'rollback_pending', rollbackRequestedAt: new Date(), rollbackRequestedById: actor.userId },
    });
    if (moved.count !== 1) throw new ConflictException({ code: 'MSA_STATE_CHANGED', message: 'The computer\'s managed state changed meanwhile. Reload and try again.' });
    await this.prisma.msaGrant.updateMany({ where: { endpointId: ep.id, state: 'issued' }, data: { state: 'cancelled' } });
    await this.endpoints.stageRotationForMsa(ep.id, actor.userId, 'msa_rollback');
    this.grants.wake(ep.id);
    return this.view(actor, ep.id);
  }

  // ── The agent's reports ───────────────────────────────────────────────────

  /**
   * One report from a managed computer's signed agent: the device secret
   * first, then only the signed Windows agent of an assigned computer, as
   * for the poll. A report about a grant moves only that computer's own
   * grant, from the state it must be in (conditional writes: a repeat
   * changes nothing). Nothing reported is text: an event, a closed outcome
   * code and closed key names. Never a password.
   */
  async report(raw: unknown) {
    this.assertEnabled();
    const p = ReportBody.safeParse(raw);
    if (!p.success) throw new BadRequestException({ code: 'MSA_REPORT_INVALID', message: 'The report is not valid.' });
    const r = p.data;
    const dev = await this.enrollment.authenticateDevice(r.rustdeskId, r.agentSecret, 'msa_report_unauthenticated');
    const ep = await this.prisma.endpoint.findUnique({
      where: { id: dev.endpointId },
      select: { id: true, tenantId: true, customerId: true, platform: true, updateChannel: true, signedSeenAt: true },
    });
    if (!ep) throw new NotFoundException('This device is not attached to a computer');
    if (!isWindowsPlatform(ep.platform) || !runsSignedAgent({ updateChannel: ep.updateChannel, signedSeenAt: ep.signedSeenAt })) {
      throw new ForbiddenException({ code: 'MSA_SIGNED_AGENT_REQUIRED', message: 'Only the signed Windows agent may report.' });
    }
    assertAssigned(ep);
    const now = new Date();
    const row = await this.row(ep.id);
    const recorded = await this.apply(ep, row, r, now);
    if (row) await this.prisma.msaManagedComputer.updateMany({ where: { endpointId: ep.id }, data: { lastReportAt: now } });
    return { recorded };
  }

  private async apply(ep: { id: string; tenantId: string | null; customerId: string | null }, row: Awaited<ReturnType<MsaManagedService['row']>>, r: Report, now: Date): Promise<boolean> {
    const base = { tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined, resource: 'endpoint', resourceId: ep.id };
    const keys = [...new Set(r.keys ?? [])];
    const outcome = r.outcome ?? null;
    const g = (states: string[]) => ({ id: r.grantId, endpointId: ep.id, state: { in: states } });
    switch (r.event) {
      case 'received': {
        // 0.73 evidence: the agent verified the grant, before it applied anything.
        const n = (await this.prisma.msaGrant.updateMany({ where: { ...g(['delivered', 'revoked']), receivedAt: null }, data: { receivedAt: now } })).count
          + (await this.prisma.msaGrant.updateMany({ where: { ...g(['issued']), receivedAt: null }, data: { state: 'delivered', deliveredAt: now, receivedAt: now } })).count;
        return n > 0;
      }
      case 'applied': {
        const n = (await this.prisma.msaGrant.updateMany({ where: g(['delivered']), data: { state: 'applied', appliedAt: now } })).count
          + (await this.prisma.msaGrant.updateMany({ where: g(['issued']), data: { state: 'applied', appliedAt: now, deliveredAt: now } })).count;
        if (!n) return false;
        if (row && row.state !== 'rollback_pending') {
          const back: ManagedState = row.verifiedAt ? 'verified' : 'pending';
          await this.prisma.msaManagedComputer.updateMany({
            where: { endpointId: ep.id, state: { not: 'rollback_pending' } },
            data: { state: back, readbackOkAt: now, failedAt: null, failReason: null, failedKeys: [] },
          });
        }
        await this.audit.log({ ...base, action: 'MSA_GRANT_APPLIED', meta: { grantId: r.grantId, endpointId: ep.id } });
        return true;
      }
      case 'failed': {
        const code = outcome ?? 'readback_mismatch';
        const n = (await this.prisma.msaGrant.updateMany({ where: g(['delivered', 'applied']), data: { state: 'failed', outcome: code, failedKeys: keys } })).count
          + (await this.prisma.msaGrant.updateMany({ where: g(['issued']), data: { state: 'failed', outcome: code, failedKeys: keys, deliveredAt: now } })).count;
        if (!n) return false;
        await this.audit.log({ ...base, action: 'MSA_GRANT_FAILED', meta: { grantId: r.grantId, endpointId: ep.id, outcome: code, keys } });
        if (row && ENFORCEMENT_OUTCOMES.has(code)) await this.failure(ep, row, code, keys, now);
        return true;
      }
      case 'connected': {
        const n = (await this.prisma.msaGrant.updateMany({ where: { ...g(['applied']), connectedAt: null }, data: { connectedAt: now } })).count;
        if (n) await this.audit.log({ ...base, action: 'MSA_SESSION_CONNECTED', meta: { grantId: r.grantId, endpointId: ep.id } });
        return n > 0;
      }
      case 'ended': {
        // 0.73: a revoked session the agent ended stays `revoked` and gains endedAt.
        const n = (await this.prisma.msaGrant.updateMany({ where: g(['applied', 'delivered']), data: { state: 'ended', endedAt: now, outcome: outcome ?? 'max_minutes' } })).count
          + (await this.prisma.msaGrant.updateMany({ where: { ...g(['revoked']), endedAt: null }, data: { endedAt: now, outcome: outcome ?? 'revoked' } })).count;
        if (!n) return false;
        await this.audit.log({ ...base, action: 'MSA_SESSION_ENDED', meta: { grantId: r.grantId, endpointId: ep.id, outcome: outcome ?? 'max_minutes' } });
        // Still pending: Legacy must keep working, and the agent just set a
        // password nobody is told. Re-establish one through the rotation path
        // (the heartbeat hands it over once no grant is in flight).
        if (row && !row.verifiedAt && row.state !== 'rollback_pending') await this.endpoints.stageRotationForMsa(ep.id, null, 'msa_session_ended');
        return true;
      }
      case 'drift': {
        if (!row) return false;
        await this.failure(ep, row, 'drift', keys, now);
        return true;
      }
      case 'checked': {
        if (!row || row.state === 'enforcement_failure' || row.state === 'rollback_pending') return false;
        await this.prisma.msaManagedComputer.updateMany({ where: { endpointId: ep.id, state: row.state }, data: { readbackOkAt: now } });
        return true;
      }
      case 'secured': {
        if (!row?.verifiedAt) return false;
        const n = (await this.prisma.msaManagedComputer.updateMany({ where: { endpointId: ep.id, verifiedAt: { not: null }, legacySecuredAt: null }, data: { legacySecuredAt: now } })).count;
        if (n) await this.audit.log({ ...base, action: 'MSA_LEGACY_SECURED', meta: { endpointId: ep.id } });
        return n > 0;
      }
      case 'restored': {
        if (row?.state !== 'rollback_pending') return false;
        const n = (await this.prisma.msaManagedComputer.deleteMany({ where: { endpointId: ep.id, state: 'rollback_pending' } })).count;
        if (n) await this.audit.log({ ...base, action: 'MSA_ROLLED_BACK', meta: { endpointId: ep.id, before: 'rollback_pending', after: 'legacy', forced: false } });
        return n > 0;
      }
      case 'restore_failed': {
        if (row?.state !== 'rollback_pending') return false;
        await this.prisma.msaManagedComputer.updateMany({ where: { endpointId: ep.id, state: 'rollback_pending' }, data: { failedAt: now, failReason: 'restore_failed', failedKeys: keys } });
        await this.audit.log({ ...base, action: 'MSA_ENFORCEMENT_FAILURE', meta: { endpointId: ep.id, reason: 'restore_failed', keys } });
        return true;
      }
    }
    return false;
  }

  private async failure(ep: { id: string; tenantId: string | null; customerId: string | null }, row: { state: string }, reason: string, keys: string[], now: Date) {
    if (row.state === 'rollback_pending') return;
    await this.prisma.msaManagedComputer.updateMany({
      where: { endpointId: ep.id, state: { not: 'rollback_pending' } },
      data: { state: 'enforcement_failure', failedAt: now, failReason: reason, failedKeys: keys },
    });
    await this.audit.log({
      tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined, resource: 'endpoint', resourceId: ep.id,
      action: 'MSA_ENFORCEMENT_FAILURE', meta: { endpointId: ep.id, reason, keys },
    });
    this.logger.warn(`Managed Secure Access enforcement failure on ${ep.id}: ${reason}`);
  }
}
