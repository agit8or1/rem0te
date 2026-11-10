import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ContainmentPause } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SignerClient } from '../actions/signer.client';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { KINDS, activePause, pauseMessage, type Kind } from './pause';

/**
 * Containment (v0.28): a global write pause and per-business suspension.
 *
 * Who may set and lift:
 *   GLOBAL      set by a Platform Admin or technicians:manage holder. Lifted
 *               by one of them who did not set it (two people), or on the
 *               host with the containment CLI.
 *   BUSINESS    set by the MSP (as above) or by the business itself (a
 *               Business Owner, not in a technician context). A customer's
 *               own suspension is lifted only by a Business Owner of that
 *               business — the MSP cannot override it. An MSP suspension is
 *               lifted by someone other than whoever set it.
 *
 * Setting needs no fresh authentication — stopping must be quick. Lifting
 * does (the controller checks), because it widens what can happen.
 *
 * A pause covering actions is also sent to the approval signer, which holds
 * its own copy. The portal can ask the signer to pause; it cannot ask it to
 * resume — that is the signer operator's CLI. And a signed pause published
 * through the update chain stops the agents themselves (see
 * docs/containment.md), which is the layer a compromised portal cannot lift.
 */
export const SetPauseDto = z.object({
  scope: z.enum(['global', 'business']),
  businessId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  kinds: z.array(z.enum(KINDS)).min(1).max(KINDS.length).default([...KINDS]),
  reason: z.string().trim().min(3).max(300),
}).strict();
export const ClearPauseDto = z.object({ reason: z.string().trim().min(3).max(300) }).strict();

@Injectable()
export class ContainmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly signer: SignerClient,
    private readonly acl: AccessControlService,
  ) {}

  // ── Asked by every write path ─────────────────────────────────────────────

  blocking(kind: Kind, customerId: string | null | undefined) { return activePause(this.prisma, kind, customerId); }

  /** Throws 403 CONTAINED when `kind` is paused for this business (the same refusal as an action or a connection). */
  async assertOpen(kind: Kind, customerId: string | null | undefined) {
    const p = await this.blocking(kind, customerId);
    if (p) throw new ForbiddenException({ code: 'CONTAINED', message: pauseMessage(p, kind), pauseId: p.id, scope: p.scope.toLowerCase() });
  }

  // ── Who may do what ───────────────────────────────────────────────────────

  private isMsp(a: ActorContext) {
    return a.isPlatformAdmin || (!a.technician && (a.platformPermissions ?? []).includes('technicians:manage' as never));
  }
  private isOwnerOf(a: ActorContext, customerId: string) {
    return !a.technician && !a.isPlatformAdmin && a.businessId === customerId && this.acl.isBusinessOwner(a);
  }

  private view(p: ContainmentPause & { customer?: { name: string } | null }) {
    return {
      id: p.id, scope: p.scope.toLowerCase(), businessId: p.customerId, businessName: p.customer?.name ?? null, kinds: p.kinds, reason: p.reason,
      setBy: p.setBy, setById: p.setById, createdAt: p.createdAt, signer: p.signerRequestedAt ? { requestedAt: p.signerRequestedAt, result: p.signerResult } : null,
      clearedAt: p.clearedAt, clearedById: p.clearedById, clearReason: p.clearReason,
    };
  }

  async state(actor: ActorContext) {
    const msp = this.isMsp(actor);
    const own = !actor.technician && actor.businessId && this.acl.isBusinessOwner(actor) ? actor.businessId : null;
    if (!msp && !own) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Containment is managed by Platform Admins, technician managers and Business Owners.' });
    const where = msp ? {} : { OR: [{ scope: 'GLOBAL' as const }, { customerId: own! }] };
    const [active, history] = await Promise.all([
      this.prisma.containmentPause.findMany({ where: { ...where, clearedAt: null }, orderBy: { createdAt: 'desc' }, include: { customer: { select: { name: true } } } }),
      this.prisma.containmentPause.findMany({ where: { ...where, clearedAt: { not: null } }, orderBy: { clearedAt: 'desc' }, take: 20, include: { customer: { select: { name: true } } } }),
    ]);
    let signer: { configured: boolean; reachable: boolean | null; pauses: unknown[] } = { configured: this.signer.configured(), reachable: null, pauses: [] };
    if (msp && signer.configured) {
      try { const r = await this.signer.pauses(); signer = { configured: true, reachable: r.status === 200, pauses: r.body.pauses ?? [] }; } catch { signer.reachable = false; }
    }
    return {
      active: active.map((p) => this.view(p)), history: history.map((p) => this.view(p)), signer,
      may: { global: msp, business: msp ? 'any' : own ? own : null },
      you: actor.userId,
    };
  }

  async set(actor: ActorContext, raw: unknown) {
    const d = SetPauseDto.safeParse(raw ?? {});
    if (!d.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: d.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const { scope, businessId, kinds, reason } = d.data;
    let setBy: 'msp' | 'customer';
    let customer: { id: string; tenantId: string } | null = null;
    if (scope === 'global') {
      if (businessId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A global pause names no business.' });
      if (!this.isMsp(actor)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'A global write pause is set by a Platform Admin or a technician manager.' });
      setBy = 'msp';
    } else {
      if (!businessId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'businessId is required.' });
      customer = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { id: true, tenantId: true } });
      if (!customer) throw new NotFoundException('Business not found');
      if (this.isMsp(actor)) setBy = 'msp';
      else if (this.isOwnerOf(actor, businessId)) setBy = 'customer';
      else throw new NotFoundException('Business not found');
    }
    const p = await this.prisma.containmentPause.create({
      data: { scope: scope === 'global' ? 'GLOBAL' : 'BUSINESS', customerId: customer?.id ?? null, kinds: [...new Set(kinds)], reason, setById: actor.userId, setBy },
    });
    await this.audit.log({ tenantId: customer?.tenantId ?? actor.tenantId ?? undefined, customerId: customer?.id, actorId: actor.userId, actorIp: actor.ip, action: 'CONTAINMENT_PAUSED', resource: 'containment_pause', resourceId: p.id, meta: { scope, kinds: p.kinds, setBy, reason } });
    // Best-effort: the portal's own pause already holds. The signer keeps its
    // copy until its operator lifts it.
    if (p.kinds.includes('actions') && this.signer.configured()) {
      let result: string;
      try {
        const r = await this.signer.pause({ scope, ...(customer ? { businessId: customer.id } : {}), reason: reason.slice(0, 200), ref: p.id });
        result = r.status === 201 ? `held as ${r.body.id}` : `refused: ${r.body.error ?? r.status}`;
      } catch { result = 'unreachable'; }
      await this.prisma.containmentPause.update({ where: { id: p.id }, data: { signerRequestedAt: new Date(), signerResult: result } });
    }
    return this.view((await this.prisma.containmentPause.findUnique({ where: { id: p.id }, include: { customer: { select: { name: true } } } }))!);
  }

  async clear(actor: ActorContext, id: string, raw: unknown) {
    const d = ClearPauseDto.safeParse(raw ?? {});
    if (!d.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'A reason of at least 3 characters is required.' });
    const p = await this.prisma.containmentPause.findUnique({ where: { id } });
    if (!p || p.clearedAt) throw new NotFoundException('No active pause with that id');
    if (p.setBy === 'customer') {
      // The customer's own suspension. The MSP cannot lift it.
      if (!p.customerId || !this.isOwnerOf(actor, p.customerId)) throw new ForbiddenException({ code: 'CUSTOMER_SUSPENSION', message: 'The business suspended this itself. Only a Business Owner of that business can lift it.' });
    } else {
      if (!this.isMsp(actor)) {
        if (p.customerId && this.isOwnerOf(actor, p.customerId)) throw new ForbiddenException({ code: 'MSP_SUSPENSION', message: 'Your MSP set this suspension. Ask them to lift it.' });
        throw new NotFoundException('No active pause with that id');
      }
      if (actor.userId === p.setById) throw new ForbiddenException({ code: 'SAME_PERSON', message: 'Someone other than whoever set this pause must lift it. (On the server, the containment CLI can also lift it.)' });
    }
    const r = await this.prisma.containmentPause.updateMany({ where: { id, clearedAt: null }, data: { clearedAt: new Date(), clearedById: actor.userId, clearReason: d.data.reason } });
    if (!r.count) throw new NotFoundException('No active pause with that id');
    await this.audit.log({ tenantId: actor.tenantId ?? undefined, customerId: p.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip, action: 'CONTAINMENT_CLEARED', resource: 'containment_pause', resourceId: id, meta: { scope: p.scope.toLowerCase(), kinds: p.kinds, reason: d.data.reason, signerStillHolds: !!p.signerRequestedAt } });
    return this.view((await this.prisma.containmentPause.findUnique({ where: { id }, include: { customer: { select: { name: true } } } }))!);
  }

  /** For the banner: what is paused for this person's current business. */
  async banner(actor: ActorContext) {
    const rows = await this.prisma.containmentPause.findMany({
      where: { clearedAt: null, OR: [{ scope: 'GLOBAL' }, ...(actor.businessId ? [{ customerId: actor.businessId }] : []), ...(this.isMsp(actor) && !actor.businessId ? [{ scope: 'BUSINESS' as const }] : [])] },
      orderBy: { createdAt: 'desc' }, take: 10, include: { customer: { select: { name: true } } },
    });
    return rows.map((p) => ({ id: p.id, scope: p.scope.toLowerCase(), businessName: p.customer?.name ?? null, kinds: p.kinds, reason: p.reason, setBy: p.setBy, createdAt: p.createdAt }));
  }
}
