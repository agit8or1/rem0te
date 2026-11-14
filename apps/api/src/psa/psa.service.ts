import { BadGatewayException, BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PsaConnector } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { EmailService } from '../email/email.service';
import { PublicUrlService } from '../platform/public-url.service';
import { activePause, pauseMessage } from '../containment/pause';
import { UserBudget } from '../common/user-budget';
import { AiService } from '../ai/ai.service';
import { KINDS, type DriverDeps, type Kind, type PsaDriver, type Scope } from './connector';
import { DRIVERS } from './connectors';
import { buildDraft, defaultSubject, NOTE_MAX, SUBJECT_MAX } from './ticket';
import { CONTROLS_ALL } from '../common/text';

const ID = /^[A-Za-z0-9_-]{8,64}$/;

const ConnectorInput = z.object({
  scope: z.enum(['global', 'business']),
  businessId: z.string().regex(ID).optional(),
  kind: z.enum(KINDS),
  enabled: z.boolean(),
  label: z.string().trim().max(60).nullable().optional(),
  emailRecipientId: z.string().regex(ID).optional(),
  webhookUrl: z.string().trim().max(2048).optional(),
  /** Absent = keep (same URL only); null = remove. */
  webhookSecret: z.string().max(256).nullable().optional(),
}).strict();

const TicketInput = z.object({
  subject: z.string().max(SUBJECT_MAX * 2).optional(),
  note: z.string().max(NOTE_MAX).optional(),
  includeAi: z.boolean().optional(),
}).passthrough();

const bad = (e: z.ZodError) => new BadRequestException({ code: 'INVALID_REQUEST', message: e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });

/**
 * PSA tickets (0.48). One connector per scope — the platform default
 * ("global", a Platform Admin's) and optionally a business's own (its
 * Business Owner's) — and the "Create ticket" button uses the business's if
 * it has an enabled one, else the platform's.
 *
 * Settings writes need fresh authentication (catalog key psa.connector, §62) and are
 * audited without secrets: an email connector by its masked address, a
 * webhook by its host only and whether a signing secret was set.
 *
 * Creating a ticket: scope (404), computers:view, the entry's own capability
 * (event logs or alerts, via AiService.resolveSource), tickets:create, the
 * per-user budget, a connector, the `notifications` containment pause (a
 * ticket is outbound like a mail), and the driver's readiness. Then one send.
 * PSA_TICKET_CREATED / PSA_TICKET_FAILED carry ids, the connector kind and
 * the returned reference — never the subject, note or body. A small PsaTicket
 * row and a computer History note record it.
 */
@Injectable()
export class PsaService {
  private readonly deps: DriverDeps;
  private readonly budget = new UserBudget(Number(process.env.PSA_TICKETS_PER_HOUR ?? 20), 3600_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly ai: AiService,
    private readonly urls: PublicUrlService,
    email: EmailService,
    config: ConfigService,
  ) {
    this.deps = { prisma, email, encKey: config.get<string>('ENCRYPTION_KEY') };
  }

  private driver(kind: string): PsaDriver {
    const d = DRIVERS[kind as Kind];
    if (!d) throw new Error(`unknown PSA connector kind ${kind}`);
    return d;
  }

  /** The scope a settings request is about, and whether the caller may write it. */
  private async scopeOf(a: ActorContext, scope: 'global' | 'business', businessId: string | null | undefined): Promise<Scope & { name: string; tenantId: string | null }> {
    if (scope === 'global') {
      if (businessId) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'The platform default names no business.' });
      if (!a.isPlatformAdmin) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'The platform default PSA connector is set by a Platform Admin.' });
      return { scopeKey: 'global', customerId: null, name: 'Platform default', tenantId: a.tenantId };
    }
    const id = businessId ?? a.businessId;
    if (!id || !ID.test(id)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'businessId is required.' });
    const c = await this.prisma.customer.findUnique({ where: { id }, select: { id: true, name: true, tenantId: true } });
    if (!c || (!a.isPlatformAdmin && a.businessId !== c.id)) throw new NotFoundException('Business not found');
    if (!a.isPlatformAdmin && (!this.acl.isBusinessOwner(a) || a.technician)) throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'A business\'s PSA connector is set by its Business Owner or a Platform Admin.' });
    return { scopeKey: `b:${c.id}`, customerId: c.id, name: c.name, tenantId: c.tenantId };
  }

  private async view(row: PsaConnector | null) {
    if (!row) return null;
    const d = this.driver(row.kind);
    return { id: row.id, scopeKey: row.scopeKey, kind: row.kind, kindLabel: d.label, enabled: row.enabled, label: row.label, updatedAt: row.updatedAt, updatedById: row.updatedById, ...(await d.view(row, this.deps)) };
  }

  async getConnector(a: ActorContext, scope: 'global' | 'business', businessId: string | null) {
    const s = await this.scopeOf(a, scope, businessId);
    const row = await this.prisma.psaConnector.findUnique({ where: { scopeKey: s.scopeKey } });
    const global = s.scopeKey === 'global' ? null : await this.prisma.psaConnector.findUnique({ where: { scopeKey: 'global' } });
    return {
      scopeKey: s.scopeKey, businessId: s.customerId, name: s.name,
      connector: await this.view(row),
      // A business sees only that a platform default exists and what kind — not its address or URL.
      platformDefault: global ? { kind: global.kind, kindLabel: this.driver(global.kind).label, enabled: global.enabled } : null,
      kinds: KINDS.map((k) => ({ kind: k, label: DRIVERS[k].label })),
    };
  }

  async putConnector(a: ActorContext, raw: unknown) {
    const d = ConnectorInput.safeParse(raw ?? {});
    if (!d.success) throw bad(d.error);
    const s = await this.scopeOf(a, d.data.scope, d.data.businessId);
    const cur = await this.prisma.psaConnector.findUnique({ where: { scopeKey: s.scopeKey } });
    const drv = this.driver(d.data.kind);
    const fields = await drv.parse(d.data as Record<string, unknown>, s, cur && cur.kind === d.data.kind ? cur : null, this.deps);
    const { audit: driverAudit, ...data } = fields;
    const label = d.data.label ? d.data.label.replace(CONTROLS_ALL, '').slice(0, 60) : null;
    const row = await this.prisma.psaConnector.upsert({
      where: { scopeKey: s.scopeKey },
      create: { scopeKey: s.scopeKey, customerId: s.customerId, kind: d.data.kind, enabled: d.data.enabled, label, ...data, updatedById: a.userId },
      update: { kind: d.data.kind, enabled: d.data.enabled, label, ...data, updatedById: a.userId },
    });
    await this.audit.logOrFail({
      action: 'PSA_CONNECTOR_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined,
      resource: 'psa_connector', resourceId: row.id,
      meta: { scope: s.scopeKey, before: cur ? { kind: cur.kind, enabled: cur.enabled } : null, after: { kind: row.kind, enabled: row.enabled }, ...driverAudit },
    });
    return this.getConnector(a, d.data.scope, s.customerId);
  }

  async removeConnector(a: ActorContext, scope: 'global' | 'business', businessId: string | null) {
    const s = await this.scopeOf(a, scope, businessId);
    const cur = await this.prisma.psaConnector.findUnique({ where: { scopeKey: s.scopeKey } });
    if (!cur) throw new NotFoundException('No connector is set here');
    await this.prisma.psaConnector.delete({ where: { id: cur.id } });
    await this.audit.logOrFail({
      action: 'PSA_CONNECTOR_CHANGED', actorId: a.userId, actorIp: a.ip, tenantId: s.tenantId ?? undefined, customerId: s.customerId ?? undefined,
      resource: 'psa_connector', resourceId: cur.id, meta: { scope: s.scopeKey, before: { kind: cur.kind, enabled: cur.enabled }, after: null },
    });
    return { removed: true };
  }

  /** The connector a computer of this business uses: its business's, else the platform default. */
  private async effective(customerId: string | null): Promise<{ row: PsaConnector; scope: 'business' | 'global' } | null> {
    if (customerId) {
      const b = await this.prisma.psaConnector.findUnique({ where: { scopeKey: `b:${customerId}` } });
      if (b?.enabled) return { row: b, scope: 'business' };
    }
    const g = await this.prisma.psaConnector.findUnique({ where: { scopeKey: 'global' } });
    return g?.enabled ? { row: g, scope: 'global' } : null;
  }

  /** For the buttons: is a ticket possible from this computer, and the tickets already made. */
  async status(a: ActorContext, endpointId: string) {
    const ep = await this.acl.assertEndpointInScope(a, endpointId, CAP.COMPUTERS_VIEW);
    this.acl.assertCapability(a, CAP.COMPUTERS_VIEW);
    const eff = await this.effective(ep.customerId);
    const pause = await activePause(this.prisma, 'notifications', ep.customerId);
    const ready = eff ? await this.driver(eff.row.kind).ready(eff.row, this.deps, ep.customerId) : null;
    const tickets = await this.prisma.psaTicket.findMany({ where: { endpointId: ep.id }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, sourceRef: true, fingerprint: true, connectorKind: true, ref: true, url: true, createdAt: true } });
    const reason = !eff ? 'No PSA is connected — a Platform Admin or the Business Owner sets one in Settings → PSA / ticketing.'
      : pause ? pauseMessage(pause, 'notifications') : ready && !ready.ok ? ready.reason : null;
    return {
      available: !!eff && !pause && !!ready?.ok, reason,
      connector: eff ? { kind: eff.row.kind, kindLabel: this.driver(eff.row.kind).label, label: eff.row.label, scope: eff.scope } : null,
      canCreate: this.acl.can(a, CAP.TICKETS_CREATE), requires: [CAP.COMPUTERS_VIEW, CAP.TICKETS_CREATE],
      tickets,
    };
  }

  /** The default subject for an entry, for the dialog. */
  async draft(a: ActorContext, endpointId: string, raw: unknown) {
    const src = await this.ai.resolveSource(a, endpointId, raw);
    const cached = await this.ai.cachedFor(src);
    return { subject: defaultSubject(src), aiAvailable: !!cached };
  }

  async create(a: ActorContext, endpointId: string, raw: unknown) {
    const t = TicketInput.safeParse(raw ?? {});
    if (!t.success) throw bad(t.error);
    const { subject, note, includeAi, ...rest } = t.data;
    const src = await this.ai.resolveSource(a, endpointId, rest);
    this.acl.assertCapability(a, CAP.TICKETS_CREATE);
    if (!this.budget.take(a.userId)) throw new HttpException({ code: 'PSA_RATE_LIMITED', message: 'You have created a lot of tickets in the last hour. Try again later.' }, 429);
    const eff = await this.effective(src.endpoint.customerId);
    if (!eff) throw new ConflictException({ code: 'PSA_NOT_CONFIGURED', message: 'No PSA is connected — a Platform Admin or the Business Owner sets one in Settings → PSA / ticketing.' });
    const pause = await activePause(this.prisma, 'notifications', src.endpoint.customerId);
    if (pause) throw new ForbiddenException({ code: 'CONTAINED', message: pauseMessage(pause, 'notifications'), pauseId: pause.id, scope: pause.scope.toLowerCase() });
    const drv = this.driver(eff.row.kind);
    const ready = await drv.ready(eff.row, this.deps, src.endpoint.customerId);
    if (!ready.ok) throw new ConflictException({ code: 'PSA_NOT_READY', message: ready.reason });

    const cached = includeAi ? await this.ai.cachedFor(src) : null;
    const draft = buildDraft(src, {
      subject, note, link: `${this.urls.web()}/endpoints/${encodeURIComponent(src.endpoint.id)}`, requestedBy: a.email,
      ai: cached ? { provider: cached.provider, model: cached.model, text: cached.answer } : null,
    });
    const base = {
      actorId: a.userId, actorIp: a.ip, actorAgent: a.userAgent, tenantId: src.endpoint.tenantId ?? undefined, customerId: src.endpoint.customerId ?? undefined,
      resource: 'endpoint', resourceId: src.endpoint.id,
    };
    const ids = { connectorKind: eff.row.kind, connectorScope: eff.scope, connectorId: eff.row.id, source: src.kind, sourceRef: src.sourceRef, aiIncluded: !!cached, aiRequested: !!includeAi, noteChars: draft.note?.length ?? 0 };
    const r = await drv.send(eff.row, draft, this.deps);
    if (!r.ok) {
      await this.audit.log({ ...base, action: 'PSA_TICKET_FAILED', meta: { ...ids, status: r.status } });
      throw new BadGatewayException({ code: 'PSA_SEND_FAILED', message: `The ticket was not created (${r.status}).` });
    }
    const ticket = await this.prisma.psaTicket.create({
      data: {
        tenantId: src.endpoint.tenantId, customerId: src.endpoint.customerId, endpointId: src.endpoint.id, sourceRef: src.sourceRef, fingerprint: src.identity,
        connectorKind: eff.row.kind, connectorScope: eff.scope, ref: r.ref ?? null, url: r.url ?? null, createdById: a.userId,
      },
    });
    const tenantId = src.endpoint.tenantId ?? a.tenantId;
    let noteAdded = false;
    if (tenantId) {
      await this.prisma.note.create({
        data: {
          tenantId, authorId: a.userId, endpointId: src.endpoint.id, customerId: src.endpoint.customerId,
          content: `Ticket created in ${drv.label}${eff.row.label ? ` (${eff.row.label})` : ''}${r.ref ? `: ${r.ref}` : ''} — ${draft.subject}`.slice(0, 1000),
        },
      });
      noteAdded = true;
    }
    await this.audit.log({ ...base, action: 'PSA_TICKET_CREATED', meta: { ...ids, ticketId: ticket.id, ref: ticket.ref, status: r.status, noteAdded } });
    return { id: ticket.id, ref: ticket.ref, url: ticket.url, connectorKind: eff.row.kind, kindLabel: drv.label, status: r.status, sourceRef: src.sourceRef, aiIncluded: !!cached, createdAt: ticket.createdAt };
  }
}
