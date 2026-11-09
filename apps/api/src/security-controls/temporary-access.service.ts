import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ControlsStore } from './controls.store';
import { SecurityAlertService } from './alerts.service';
import { assertFresh, assertIndependentReviewer } from './review';

export type TemporaryMode = 'CONTROL' | 'ELEVATION' | 'PROTECTED_EXCEPTION';

/**
 * Time-limited access, in three steps held by different people:
 *
 *   request   the technician, for one computer, one mode, with a reason
 *   decide    an independent reviewer (never the requester)
 *   activate  the requester again, with FRESH authentication — a passkey for
 *             a protected-device exception — which starts the clock
 *
 * An approved grant that is never activated does nothing. Activation re-checks
 * eligibility, so a demotion between approval and activation ends it. The
 * launch decision (AccessPolicyService.evaluateLaunch) re-checks everything
 * again, so this row is necessary but never sufficient.
 */
@Injectable()
export class TemporaryAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly controls: ControlsStore,
    private readonly alerts: SecurityAlertService,
  ) {}

  /** Is this actor eligible to even ASK for `mode` on this computer? */
  private eligible(actor: ActorContext, endpointId: string, mode: TemporaryMode): string | null {
    if (mode === 'PROTECTED_EXCEPTION') return null; // anyone who can reach it may ask; approval is the gate
    if (!actor.technician) return mode === 'CONTROL' ? 'Business members and admins do not need temporary control.' : 'Elevated sessions are unavailable: no privileged helper exists on the endpoint.';
    const covering = actor.technician.sources.filter((s) => s.presetPolicy && (s.endpointIds === null || s.endpointIds.includes(endpointId)));
    if (mode === 'CONTROL' && !covering.some((s) => s.presetPolicy!.remoteControl === 'request')) return 'Your access level is not eligible to request interactive control on this computer.';
    if (mode === 'ELEVATION') {
      if (!covering.some((s) => s.presetPolicy!.elevation === 'request')) return 'Your access level is not eligible to request elevation.';
      return 'Elevated sessions are unavailable: no privileged helper exists on the endpoint to enforce them.';
    }
    return null;
  }

  async request(actor: ActorContext, p: { endpointId: string; mode: TemporaryMode; reason: string; durationMinutes: number }) {
    await this.acl.assertEndpointInScope(actor, p.endpointId, CAP.COMPUTERS_VIEW);
    const ep = await this.prisma.endpoint.findUnique({ where: { id: p.endpointId }, select: { id: true, customerId: true, name: true } });
    if (!ep?.customerId) throw new NotFoundException('Computer not found');
    const why = this.eligible(actor, ep.id, p.mode);
    if (why) throw new ForbiddenException({ code: 'NOT_ELIGIBLE', message: why });
    const controls = await this.controls.effective(ep.customerId);
    const duration = Math.max(5, Math.min(p.durationMinutes, controls.maxSessionMinutes));
    const open = await this.prisma.temporaryAccessRequest.findFirst({ where: { userId: actor.userId, endpointId: ep.id, mode: p.mode, status: 'PENDING' } });
    if (open) throw new ConflictException('You already have a pending request for this computer');
    const row = await this.prisma.temporaryAccessRequest.create({
      data: { userId: actor.userId, customerId: ep.customerId, endpointId: ep.id, mode: p.mode, reason: p.reason.slice(0, 500), durationMinutes: duration },
    });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, customerId: ep.customerId, action: 'TEMPORARY_ACCESS_REQUESTED',
      resource: 'temporary_access', resourceId: row.id, meta: { endpointId: ep.id, mode: p.mode, durationMinutes: duration },
    });
    if (p.mode === 'PROTECTED_EXCEPTION') {
      await this.alerts.raise({ kind: 'protected_exception_requested', identity: `user:${actor.userId}`, customerId: ep.customerId, details: { request: row.id, endpointId: ep.id }, destinations: controls.alertDestinations });
    }
    return row;
  }

  list(filter: { userId?: string; status?: string }) {
    return this.prisma.temporaryAccessRequest.findMany({ where: { ...(filter.userId ? { userId: filter.userId } : {}), ...(filter.status ? { status: filter.status } : {}) }, orderBy: { createdAt: 'desc' }, take: 200 });
  }

  async decide(actor: ActorContext, id: string, decision: 'APPROVE' | 'DENY', note?: string) {
    const row = await this.prisma.temporaryAccessRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Request not found');
    assertIndependentReviewer(actor, row.userId, 'temporary access request');
    const done = await this.prisma.temporaryAccessRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: decision === 'APPROVE' ? 'APPROVED' : 'DENIED', decidedById: actor.userId, decidedAt: new Date(), decisionNote: note?.slice(0, 500) ?? null },
    });
    if (done.count !== 1) throw new ConflictException('Request is no longer pending');
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, customerId: row.customerId, action: 'TEMPORARY_ACCESS_DECIDED', resource: 'temporary_access', resourceId: id, meta: { decision, mode: row.mode, requester: row.userId } });
    return this.prisma.temporaryAccessRequest.findUnique({ where: { id } });
  }

  async activate(actor: ActorContext, id: string, freshMethod: string | null) {
    const row = await this.prisma.temporaryAccessRequest.findUnique({ where: { id } });
    if (!row || row.userId !== actor.userId) throw new NotFoundException('Request not found');
    if (row.status !== 'APPROVED' || row.activatedAt) throw new ConflictException('Only an approved, not-yet-activated request can be activated');
    assertFresh(freshMethod, { phishingResistant: row.mode === 'PROTECTED_EXCEPTION' });
    // Still eligible now? A demotion after approval ends it here.
    await this.acl.assertEndpointInScope(actor, row.endpointId, CAP.COMPUTERS_VIEW);
    const why = this.eligible(actor, row.endpointId, row.mode as TemporaryMode);
    if (why) throw new ForbiddenException({ code: 'NOT_ELIGIBLE', message: why });
    const now = new Date();
    const done = await this.prisma.temporaryAccessRequest.updateMany({
      where: { id, status: 'APPROVED', activatedAt: null },
      data: { activatedAt: now, expiresAt: new Date(now.getTime() + row.durationMinutes * 60_000) },
    });
    if (done.count !== 1) throw new ConflictException('Already activated');
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, customerId: row.customerId, action: 'TEMPORARY_ACCESS_ACTIVATED', resource: 'temporary_access', resourceId: id, meta: { mode: row.mode, method: freshMethod, minutes: row.durationMinutes } });
    return this.prisma.temporaryAccessRequest.findUnique({ where: { id } });
  }

  /** Requester, a reviewer, or an admin may end it at any time. */
  async revoke(actor: ActorContext, id: string) {
    const row = await this.prisma.temporaryAccessRequest.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Request not found');
    const allowed = row.userId === actor.userId || actor.isPlatformAdmin || (actor.platformPermissions ?? []).includes('approvals:review');
    if (!allowed) throw new ForbiddenException('Not allowed');
    if (!['PENDING', 'APPROVED'].includes(row.status)) throw new BadRequestException('Nothing to revoke');
    await this.prisma.temporaryAccessRequest.update({ where: { id }, data: { status: 'REVOKED', expiresAt: new Date() } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, customerId: row.customerId, action: 'TEMPORARY_ACCESS_DECIDED', resource: 'temporary_access', resourceId: id, meta: { decision: 'REVOKE' } });
    return { revoked: true };
  }
}
