import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Prisma, SupportRequestStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { TechnicianAccessService } from '../rbac/technician-access.service';
import { CAP, effectiveCapabilities } from '../rbac/capabilities';
import { PublicUrlService } from '../platform/public-url.service';
import {
  SUPPORT_MAX_TEXT, SUPPORT_OPEN_PER_DEVICE, SUPPORT_PER_DEVICE_HOUR, SUPPORT_PER_USER_HOUR, screenshot as checkScreenshot, usageSample,
} from '../tray/tray-policy';

/**
 * Customer support requests: a waiting queue in front of Connect and Quick
 * Connect. Not a ticketing system — a request exists until someone connects
 * and closes it, and is then erased by retention.
 *
 * The rules that matter, and where they are enforced:
 *
 *   business      PUBLIC requests take their business from the intake link's
 *                 slug and nothing else; no body or query field is read for
 *                 it. The slug is server-generated and unguessable, and a
 *                 disabled intake answers exactly like an unknown one.
 *   inventory     Nothing public ever reveals a computer. A customer can type
 *                 a RustDesk ID; it is stored as text and matched to a
 *                 computer only in the queue, only for a technician who can
 *                 already reach that computer.
 *   claim         One conditional update on (id, status, version). Two
 *                 technicians clicking Claim together: one wins, the other
 *                 gets 409 naming who has it. Nobody is silently overwritten.
 *   hand-off      Only to someone who can handle requests in THAT business
 *                 right now — checked server side, including technicians
 *                 through an assignment.
 *   status link   An unguessable token, stored hashed, that expires; it
 *                 shows status words and a technician's first name, never an
 *                 email, a computer or another request.
 *   retention     WAITING requests expire after 24 hours; closed requests
 *                 lose their contact details and description after 30 days.
 *   tray (0.36)   AGENT requests come from the tray on a managed computer,
 *                 for that computer and its business only (the credential
 *                 proved which); a screenshot or usage sample is an
 *                 attachment, readable only by someone who can see the
 *                 request AND the computer, and deleted with the contact
 *                 details (or after 45 days, whichever is first).
 */

const OPEN: SupportRequestStatus[] = ['WAITING', 'CLAIMED', 'CONNECTING'];
const STATUS_TTL_MS = 7 * 24 * 3600_000;
const WAITING_EXPIRY_MS = 24 * 3600_000;
const ANONYMIZE_AFTER_MS = 30 * 24 * 3600_000;
/** Most open PUBLIC requests one business accepts at a time. */
const PUBLIC_OPEN_CAP = 25;
/** Most open PUBLIC requests from one address per business. */
const PER_IP_OPEN_CAP = 3;
/** A form submitted faster than a person could read it is a bot. */
const MIN_FILL_MS = 2_500;
/** Attachments never outlive this, whatever the request's state. */
const ATTACHMENT_MAX_AGE_MS = 45 * 24 * 3600_000;

const CUSTOMER_STATUS: Record<SupportRequestStatus, string> = {
  WAITING: 'Waiting for a technician',
  CLAIMED: 'A technician has picked up your request',
  CONNECTING: 'A technician is connecting to your computer',
  COMPLETED: 'Your request has been closed',
  CANCELED: 'This request was canceled',
  EXPIRED: 'This request expired without being picked up',
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Control characters become spaces, so stored text renders inertly. */
const clean = (v: unknown, n: number) =>
  typeof v === 'string'
    ? Array.from(v, (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch)).join('').trim().slice(0, n) || null
    : null;

export interface PublicSubmission {
  name?: string; email?: string; phone?: string; description?: string; rustdeskId?: string;
  /** Honeypot: hidden from people, filled in by form bots. */
  website?: string;
  /** Milliseconds the page was open before submitting (client-measured). */
  elapsedMs?: number;
}

@Injectable()
export class SupportRequestsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupportRequestsService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly techAccess: TechnicianAccessService,
    private readonly urls: PublicUrlService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.retention().catch((e) => this.logger.error('Support request retention failed', e));
    }, 10 * 60_000);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private ipHash(ip?: string) {
    return ip ? sha(`${process.env.ENCRYPTION_KEY ?? ''}:${ip}`) : null;
  }

  // ── Intake settings (Business Owner / Platform Admin) ───────────────────

  private assertOwnerOf(actor: ActorContext, businessId: string) {
    if (actor.technician) throw new ForbiddenException('Switch back to your own business to change its settings');
    if (actor.isPlatformAdmin) return;
    if (!this.acl.isBusinessOwner(actor) || actor.businessId !== businessId) {
      throw new ForbiddenException('Only a Business Owner can change the support intake');
    }
  }

  private intakeView(c: { id: string; name: string; supportIntakeEnabled: boolean; supportIntakeSlug: string | null }) {
    const base = this.urls.webConfigured() ?? '';
    return {
      businessId: c.id, businessName: c.name, enabled: c.supportIntakeEnabled, slug: c.supportIntakeSlug,
      url: c.supportIntakeSlug ? `${base}/support/${c.supportIntakeSlug}` : null,
    };
  }

  async getIntake(actor: ActorContext, businessId?: string) {
    const id = this.acl.requireScope(actor, businessId);
    this.assertOwnerOf(actor, id);
    const c = await this.prisma.customer.findUniqueOrThrow({
      where: { id }, select: { id: true, name: true, supportIntakeEnabled: true, supportIntakeSlug: true },
    });
    return this.intakeView(c);
  }

  async setIntake(actor: ActorContext, businessId: string | undefined, enabled: boolean, regenerate = false) {
    const id = this.acl.requireScope(actor, businessId);
    this.assertOwnerOf(actor, id);
    const cur = await this.prisma.customer.findUniqueOrThrow({ where: { id }, select: { supportIntakeSlug: true } });
    const slug = regenerate || !cur.supportIntakeSlug ? randomBytes(12).toString('base64url') : cur.supportIntakeSlug;
    const c = await this.prisma.customer.update({
      where: { id }, data: { supportIntakeEnabled: enabled, supportIntakeSlug: slug },
      select: { id: true, name: true, tenantId: true, supportIntakeEnabled: true, supportIntakeSlug: true },
    });
    await this.audit.log({
      tenantId: c.tenantId, customerId: id, actorId: actor.userId, actorIp: actor.ip,
      action: 'SUPPORT_INTAKE_CHANGED', resource: 'customer', resourceId: id,
      meta: { enabled, regenerated: regenerate || !cur.supportIntakeSlug },
    });
    return this.intakeView(c);
  }

  // ── Public ───────────────────────────────────────────────────────────────

  private async intakeBusiness(slug: string) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(slug)) throw new NotFoundException('This support link is not active');
    const c = await this.prisma.customer.findFirst({
      where: { supportIntakeSlug: slug, supportIntakeEnabled: true, isActive: true },
      select: { id: true, tenantId: true, name: true },
    });
    // Disabled, inactive and unknown all look the same from outside.
    if (!c) throw new NotFoundException('This support link is not active');
    return c;
  }

  async publicIntake(slug: string) {
    const c = await this.intakeBusiness(slug);
    return { businessName: c.name };
  }

  async publicSubmit(slug: string, body: PublicSubmission, ip?: string) {
    const c = await this.intakeBusiness(slug);
    // Bots: answer as if accepted, store nothing, so there is nothing to tune
    // against. A real person never sees the honeypot field.
    if ((body.website ?? '').trim() !== '' || (typeof body.elapsedMs === 'number' && body.elapsedMs < MIN_FILL_MS)) {
      return { accepted: true, statusToken: randomBytes(32).toString('base64url') };
    }
    const name = clean(body.name, 120);
    const description = clean(body.description, 2000);
    if (!name) throw new BadRequestException('Please enter your name');
    if (!description) throw new BadRequestException('Please describe what you need help with');
    const email = clean(body.email, 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('That email address does not look right');
    const rid = (body.rustdeskId ?? '').replace(/[\s-]/g, '');
    if (rid && !/^\d{6,15}$/.test(rid)) throw new BadRequestException('The remote ID should be the number shown by the support app');

    const ipHash = this.ipHash(ip);
    const [openForBusiness, openForIp] = await Promise.all([
      this.prisma.supportRequest.count({ where: { customerId: c.id, origin: 'PUBLIC', status: { in: OPEN } } }),
      ipHash ? this.prisma.supportRequest.count({ where: { customerId: c.id, submitIpHash: ipHash, status: { in: OPEN } } }) : 0,
    ]);
    if (openForBusiness >= PUBLIC_OPEN_CAP) {
      throw new ConflictException('This support desk has too many waiting requests right now. Please call them instead.');
    }
    if (openForIp >= PER_IP_OPEN_CAP) {
      throw new ConflictException('You already have requests waiting. A technician will pick them up.');
    }

    const token = randomBytes(32).toString('base64url');
    const r = await this.prisma.supportRequest.create({
      data: {
        tenantId: c.tenantId, customerId: c.id, origin: 'PUBLIC',
        contactName: name, contactEmail: email, contactPhone: clean(body.phone, 40), description,
        reportedRustdeskId: rid || null, unmanaged: true,
        statusTokenHash: sha(token), statusExpiresAt: new Date(Date.now() + STATUS_TTL_MS),
        submitIpHash: ipHash,
        events: { create: { event: 'submitted', detail: { origin: 'PUBLIC' } } },
      },
      select: { id: true },
    });
    await this.audit.log({
      tenantId: c.tenantId, customerId: c.id, actorIp: ip,
      action: 'SUPPORT_REQUEST_SUBMITTED', resource: 'support_request', resourceId: r.id, meta: { origin: 'PUBLIC' },
    });
    return { accepted: true, statusToken: token };
  }

  private async byStatusToken(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('This status link is not valid');
    const r = await this.prisma.supportRequest.findUnique({
      where: { statusTokenHash: sha(token) },
      select: {
        id: true, tenantId: true, customerId: true, status: true, createdAt: true, updatedAt: true, closedAt: true,
        statusExpiresAt: true, anonymizedAt: true,
        customer: { select: { name: true } }, claimedBy: { select: { firstName: true } },
      },
    });
    if (!r || r.anonymizedAt || r.statusExpiresAt < new Date()) throw new NotFoundException('This status link is not valid');
    return r;
  }

  async publicStatus(token: string) {
    const r = await this.byStatusToken(token);
    return {
      businessName: r.customer.name,
      status: r.status,
      statusText: CUSTOMER_STATUS[r.status],
      technician: r.status === 'CLAIMED' || r.status === 'CONNECTING' ? (r.claimedBy?.firstName ?? 'A technician') : null,
      submittedAt: r.createdAt,
      updatedAt: r.updatedAt,
      open: OPEN.includes(r.status),
    };
  }

  async publicCancel(token: string, ip?: string) {
    const r = await this.byStatusToken(token);
    const u = await this.prisma.supportRequest.updateMany({
      where: { id: r.id, status: { in: ['WAITING', 'CLAIMED'] } },
      data: { status: 'CANCELED', closedAt: new Date(), outcome: 'canceled_by_customer', version: { increment: 1 } },
    });
    if (u.count === 0) throw new ConflictException('This request can no longer be canceled here');
    await this.prisma.supportRequestEvent.create({ data: { requestId: r.id, event: 'canceled', detail: { by: 'customer' } } });
    await this.audit.log({
      tenantId: r.tenantId, customerId: r.customerId, actorIp: ip,
      action: 'SUPPORT_REQUEST_CANCELED', resource: 'support_request', resourceId: r.id, meta: { by: 'customer' },
    });
    return this.publicStatus(token);
  }

  // ── Portal: a signed-in business user asks for help ──────────────────────

  async portalSubmit(actor: ActorContext, dto: { description?: string; endpointId?: string; phone?: string }) {
    if (actor.technician || !actor.businessId || actor.isPlatformAdmin) {
      throw new ForbiddenException('Support requests are raised by people in the business that needs help');
    }
    const description = clean(dto.description, 2000);
    if (!description) throw new BadRequestException('Please describe what you need help with');
    let endpointId: string | null = null;
    if (dto.endpointId) {
      // Only a computer this person can already see in their own business.
      const ep = await this.prisma.endpoint.findFirst({
        where: { id: dto.endpointId, ...this.acl.endpointVisibilityWhere(actor) },
        select: { id: true, customerId: true },
      });
      if (!ep || ep.customerId !== actor.businessId) throw new NotFoundException('Computer not found');
      endpointId = ep.id;
    }
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true, email: true } });
    const open = await this.prisma.supportRequest.count({ where: { submittedById: actor.userId, status: { in: OPEN } } });
    if (open >= PER_IP_OPEN_CAP) throw new ConflictException('You already have requests waiting. A technician will pick them up.');
    const token = randomBytes(32).toString('base64url');
    const r = await this.prisma.supportRequest.create({
      data: {
        tenantId: actor.tenantId!, customerId: actor.businessId, origin: 'PORTAL', submittedById: actor.userId,
        contactName: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || null,
        contactEmail: user?.email ?? null, contactPhone: clean(dto.phone, 40), description, endpointId, unmanaged: !endpointId,
        statusTokenHash: sha(token), statusExpiresAt: new Date(Date.now() + STATUS_TTL_MS),
        events: { create: { event: 'submitted', actorId: actor.userId, detail: { origin: 'PORTAL' } } },
      },
      select: { id: true },
    });
    await this.audit.log({
      tenantId: actor.tenantId ?? undefined, customerId: actor.businessId, actorId: actor.userId, actorIp: actor.ip,
      action: 'SUPPORT_REQUEST_SUBMITTED', resource: 'support_request', resourceId: r.id, meta: { origin: 'PORTAL', endpointId },
    });
    return { id: r.id, statusToken: token };
  }

  // ── The tray on a managed computer (0.36) ────────────────────────────────

  /**
   * A support request from the tray. The computer and its business come from
   * the credential the tray (or the signed agent's tray host) proved — never
   * from the body. Rate-limited per computer and per Windows account, and
   * capped for open requests per computer. Not stopped by containment: asking
   * for help is not a write to anything the business has paused.
   */
  async agentSubmit(ep: { id: string; tenantId: string | null; customerId: string | null }, dto: {
    description?: unknown; localUser?: string | null; usage?: unknown; screenshot?: unknown; via: 'signed' | 'tray_key';
  }, opts: { fromChat?: boolean; fixedDescription?: string } = {}) {
    if (!ep.customerId || !ep.tenantId) throw new ConflictException({ code: 'NO_BUSINESS', message: 'This computer is not assigned to a business yet.' });
    const description = opts.fixedDescription ?? clean(dto.description, SUPPORT_MAX_TEXT);
    if (!description) throw new BadRequestException({ code: 'SUPPORT_EMPTY', message: 'Please describe what you need help with.' });
    const shot = dto.screenshot !== undefined && dto.screenshot !== null && dto.screenshot !== '' ? checkScreenshot(dto.screenshot) : null;
    if (shot && !shot.ok) throw new BadRequestException({ code: shot.code, message: 'The screenshot was refused: a JPEG or PNG of at most 700 KB and 4096 pixels a side.' });
    const usage = dto.usage !== undefined && dto.usage !== null ? usageSample(dto.usage) : null;
    if (dto.usage !== undefined && dto.usage !== null && !usage) throw new BadRequestException({ code: 'USAGE_INVALID', message: 'The resource-usage sample was not readable.' });

    const hourAgo = new Date(Date.now() - 3600_000);
    const mine = { endpointId: ep.id, origin: 'AGENT' };
    const [lastHour, userHour, open] = await Promise.all([
      this.prisma.supportRequest.count({ where: { ...mine, createdAt: { gt: hourAgo } } }),
      dto.localUser ? this.prisma.supportRequest.count({ where: { ...mine, contactName: dto.localUser, createdAt: { gt: hourAgo } } }) : 0,
      this.prisma.supportRequest.count({ where: { ...mine, status: { in: OPEN } } }),
    ]);
    if (lastHour >= SUPPORT_PER_DEVICE_HOUR) throw new HttpException({ code: 'SUPPORT_RATE_LIMITED', message: `At most ${SUPPORT_PER_DEVICE_HOUR} requests an hour from one computer.` }, HttpStatus.TOO_MANY_REQUESTS);
    if (userHour >= SUPPORT_PER_USER_HOUR) throw new HttpException({ code: 'SUPPORT_RATE_LIMITED', message: `At most ${SUPPORT_PER_USER_HOUR} requests an hour from one person.` }, HttpStatus.TOO_MANY_REQUESTS);
    if (open >= SUPPORT_OPEN_PER_DEVICE) throw new ConflictException({ code: 'SUPPORT_OPEN_CAP', message: 'This computer already has requests waiting. A technician will pick them up.' });

    const token = randomBytes(32).toString('base64url');
    const attachments: Prisma.SupportRequestAttachmentCreateWithoutRequestInput[] = [];
    if (shot?.ok) attachments.push({ kind: 'screenshot', contentType: shot.contentType, sizeBytes: shot.bytes.length, width: shot.width, height: shot.height, bytes: shot.bytes });
    if (usage) attachments.push({ kind: 'usage', contentType: 'application/json', sizeBytes: Buffer.byteLength(JSON.stringify(usage)), data: usage as unknown as Prisma.InputJsonValue });
    const r = await this.prisma.supportRequest.create({
      data: {
        tenantId: ep.tenantId, customerId: ep.customerId, origin: 'AGENT',
        contactName: dto.localUser ?? null, description, endpointId: ep.id, unmanaged: false,
        statusTokenHash: sha(token), statusExpiresAt: new Date(Date.now() + STATUS_TTL_MS),
        events: { create: { event: 'submitted', detail: { origin: 'AGENT', via: dto.via, screenshot: !!shot?.ok, usage: !!usage, ...(opts.fromChat ? { chat: true } : {}) } } },
        ...(attachments.length ? { attachments: { create: attachments } } : {}),
      },
      select: { id: true },
    });
    await this.audit.log({
      tenantId: ep.tenantId, customerId: ep.customerId,
      action: 'SUPPORT_REQUEST_SUBMITTED', resource: 'support_request', resourceId: r.id,
      meta: { origin: 'AGENT', endpointId: ep.id, screenshot: !!shot?.ok, usage: !!usage },
    });
    return { id: r.id };
  }

  /**
   * GET /support-requests/:id/attachments/:aid — the queue's own scope (as
   * detail()) AND the computer the request is for, through the device-list
   * visibility rule and the technician grant. A request for a computer the
   * caller cannot see shows its attachments to nobody, exactly as a missing one.
   */
  async attachment(actor: ActorContext, id: string, attachmentId: string) {
    await this.load(actor, id);
    const r = await this.prisma.supportRequest.findUniqueOrThrow({ where: { id }, select: { endpointId: true } });
    if (!r.endpointId || !(await this.computerVisible(actor, r.endpointId))) throw new NotFoundException('Attachment not found');
    const a = await this.prisma.supportRequestAttachment.findFirst({ where: { id: attachmentId, requestId: id } });
    if (!a) throw new NotFoundException('Attachment not found');
    return a;
  }

  private async computerVisible(actor: ActorContext, endpointId: string): Promise<boolean> {
    try {
      await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_VIEW);
    } catch {
      return false;
    }
    const ep = await this.prisma.endpoint.findFirst({ where: { AND: [this.acl.endpointVisibilityWhere(actor), { id: endpointId }] }, select: { id: true } });
    return !!ep;
  }

  // ── Queue (support:requests) ─────────────────────────────────────────────

  private queueScope(actor: ActorContext, businessId?: string) {
    this.acl.assertCapability(actor, CAP.SUPPORT_REQUESTS);
    const scope = this.acl.resolveScope(actor, businessId);
    return scope ? { customerId: scope } : {};
  }

  /** Match a typed-in RustDesk ID to a computer — only one this caller can reach. */
  private async matchComputers(actor: ActorContext, rows: { reportedRustdeskId: string | null; endpointId: string | null }[]) {
    const ids = [...new Set(rows.map((r) => r.reportedRustdeskId).filter((x): x is string => !!x))];
    const epIds = [...new Set(rows.map((r) => r.endpointId).filter((x): x is string => !!x))];
    if (!ids.length && !epIds.length) return new Map<string, { id: string; name: string }>();
    const eps = await this.prisma.endpoint.findMany({
      where: {
        AND: [
          this.acl.endpointVisibilityWhere(actor),
          { OR: [{ id: { in: epIds } }, { rustdeskNode: { rustdeskId: { in: ids } } }] },
        ],
      },
      select: { id: true, name: true, customerId: true, accessMode: true, rustdeskNode: { select: { rustdeskId: true } } },
    });
    const m = new Map<string, { id: string; name: string }>();
    for (const e of eps) {
      if (!(await this.acl.canReachEndpoint(actor, e))) continue;
      m.set(`ep:${e.id}`, { id: e.id, name: e.name });
      if (e.rustdeskNode?.rustdeskId) m.set(`rd:${e.rustdeskNode.rustdeskId}`, { id: e.id, name: e.name });
    }
    return m;
  }

  async list(actor: ActorContext, opts: { businessId?: string; status?: string; mine?: boolean } = {}) {
    const where: Prisma.SupportRequestWhereInput = {
      ...this.queueScope(actor, opts.businessId),
      ...(opts.status === 'open' || !opts.status ? { status: { in: OPEN } }
        : opts.status === 'closed' ? { status: { notIn: OPEN } }
          : { status: opts.status as SupportRequestStatus }),
      ...(opts.mine ? { claimedById: actor.userId } : {}),
      anonymizedAt: null,
    };
    const rows = await this.prisma.supportRequest.findMany({
      where, orderBy: { createdAt: 'asc' }, take: 200,
      select: {
        id: true, customerId: true, origin: true, status: true, version: true, createdAt: true, updatedAt: true,
        contactName: true, contactEmail: true, contactPhone: true, description: true,
        reportedRustdeskId: true, endpointId: true, claimedAt: true, closedAt: true, outcome: true,
        customer: { select: { id: true, name: true } },
        claimedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    const match = await this.matchComputers(actor, rows);
    return rows.map((r) => ({
      ...r,
      computer: (r.endpointId && match.get(`ep:${r.endpointId}`)) || (r.reportedRustdeskId && match.get(`rd:${r.reportedRustdeskId}`)) || null,
      claimedByMe: r.claimedBy?.id === actor.userId,
    }));
  }

  private async load(actor: ActorContext, id: string) {
    const r = await this.prisma.supportRequest.findFirst({
      where: { id, ...this.queueScope(actor), anonymizedAt: null },
      select: {
        id: true, tenantId: true, customerId: true, status: true, version: true, claimedById: true,
        claimedBy: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    if (!r) throw new NotFoundException('Support request not found');
    return r;
  }

  async detail(actor: ActorContext, id: string) {
    await this.load(actor, id);
    const r = await this.prisma.supportRequest.findUniqueOrThrow({
      where: { id },
      include: {
        customer: { select: { id: true, name: true } },
        claimedBy: { select: { id: true, firstName: true, lastName: true, email: true } },
        events: { orderBy: { createdAt: 'asc' } },
        sessions: { select: { id: true, status: true, createdAt: true, isAdHoc: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    const match = await this.matchComputers(actor, [r]);
    const { statusTokenHash: _h, submitIpHash: _i, ...safe } = r;
    // Attachments (0.36): listed only when the caller can see the computer.
    const visible = r.endpointId ? await this.computerVisible(actor, r.endpointId) : false;
    const atts = visible
      ? await this.prisma.supportRequestAttachment.findMany({
        where: { requestId: id }, orderBy: { createdAt: 'asc' },
        select: { id: true, kind: true, contentType: true, sizeBytes: true, width: true, height: true, data: true, createdAt: true },
      })
      : [];
    return {
      ...safe,
      attachments: atts.map((a) => (a.kind === 'usage' ? a : { ...a, data: undefined })),
      attachmentsHidden: visible ? 0 : await this.prisma.supportRequestAttachment.count({ where: { requestId: id } }),
      computer: (r.endpointId && match.get(`ep:${r.endpointId}`)) || (r.reportedRustdeskId && match.get(`rd:${r.reportedRustdeskId}`)) || null,
    };
  }

  private canManage(actor: ActorContext, r: { claimedById: string | null }) {
    return r.claimedById === actor.userId || (this.acl.isBusinessOwner(actor) && !actor.technician);
  }

  private who(u: { firstName: string | null; lastName: string | null; email: string } | null) {
    return u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email) : 'someone';
  }

  async claim(actor: ActorContext, id: string, version: number) {
    const r = await this.load(actor, id);
    const u = await this.prisma.supportRequest.updateMany({
      where: { id, status: 'WAITING', version },
      data: { status: 'CLAIMED', claimedById: actor.userId, claimedAt: new Date(), version: { increment: 1 } },
    });
    if (u.count === 0) {
      const cur = await this.load(actor, id);
      if (cur.claimedById === actor.userId) throw new ConflictException('You have already claimed this request');
      throw new ConflictException(
        cur.status === 'WAITING' ? 'This request changed since you loaded it. Refresh and try again.'
          : cur.claimedById ? `Already claimed by ${this.who(cur.claimedBy)}` : `This request is ${cur.status.toLowerCase()}`,
      );
    }
    await this.event(r, actor, 'claimed', {}, 'SUPPORT_REQUEST_CLAIMED');
    return this.detail(actor, id);
  }

  /** Can `userId` handle support requests in `businessId` right now? */
  private async canHandle(userId: string, businessId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true, isPlatformAdmin: true,
        memberships: { where: { isActive: true }, select: { customerId: true, capabilities: true, role: { select: { type: true } } } },
      },
    });
    if (!user || user.status !== 'ACTIVE') return false;
    if (user.isPlatformAdmin) return true;
    const m = user.memberships.find((x) => x.customerId === businessId);
    if (m && effectiveCapabilities({ roleType: m.role.type, capabilities: m.capabilities }).includes(CAP.SUPPORT_REQUESTS)) return true;
    const scope = await this.techAccess.scopeFor(userId, businessId);
    return !!scope?.capabilities.includes(CAP.SUPPORT_REQUESTS);
  }

  async handoff(actor: ActorContext, id: string, toUserId: string, version: number, note?: string) {
    const r = await this.load(actor, id);
    if (!['CLAIMED', 'CONNECTING'].includes(r.status)) throw new ConflictException('Only a claimed request can be handed off');
    if (!this.canManage(actor, r)) throw new ForbiddenException('Only the technician who claimed it, or a Business Owner, can hand it off');
    if (toUserId === r.claimedById) throw new BadRequestException('That person already has it');
    if (!(await this.canHandle(toUserId, r.customerId))) {
      throw new ForbiddenException('That person cannot handle support requests for this business');
    }
    const u = await this.prisma.supportRequest.updateMany({
      where: { id, status: { in: ['CLAIMED', 'CONNECTING'] }, version, claimedById: r.claimedById },
      data: { status: 'CLAIMED', claimedById: toUserId, claimedAt: new Date(), version: { increment: 1 } },
    });
    if (u.count === 0) throw new ConflictException('This request changed since you loaded it. Refresh and try again.');
    await this.event(r, actor, 'handed_off', { from: r.claimedById, to: toUserId, note: clean(note, 300) }, 'SUPPORT_REQUEST_HANDED_OFF');
    return this.detail(actor, id);
  }

  async release(actor: ActorContext, id: string, version: number) {
    const r = await this.load(actor, id);
    if (!this.canManage(actor, r)) throw new ForbiddenException('Only the technician who claimed it, or a Business Owner, can release it');
    const u = await this.prisma.supportRequest.updateMany({
      where: { id, status: { in: ['CLAIMED', 'CONNECTING'] }, version },
      data: { status: 'WAITING', claimedById: null, claimedAt: null, version: { increment: 1 } },
    });
    if (u.count === 0) throw new ConflictException('This request changed since you loaded it. Refresh and try again.');
    await this.event(r, actor, 'released', {}, null);
    return this.detail(actor, id);
  }

  async close(actor: ActorContext, id: string, kind: 'COMPLETED' | 'CANCELED', version: number, outcome?: string) {
    const r = await this.load(actor, id);
    // A waiting request nobody has claimed can be canceled by an owner (spam).
    if (!(this.canManage(actor, r) || (kind === 'CANCELED' && r.status === 'WAITING' && this.acl.isBusinessOwner(actor)))) {
      throw new ForbiddenException('Only the technician who claimed it, or a Business Owner, can close it');
    }
    const u = await this.prisma.supportRequest.updateMany({
      where: { id, status: { in: kind === 'COMPLETED' ? ['CLAIMED', 'CONNECTING'] : OPEN }, version },
      data: { status: kind, closedAt: new Date(), outcome: clean(outcome, 300), version: { increment: 1 } },
    });
    if (u.count === 0) throw new ConflictException('This request changed since you loaded it. Refresh and try again.');
    await this.event(r, actor, kind === 'COMPLETED' ? 'completed' : 'canceled', { outcome: clean(outcome, 300) },
      kind === 'COMPLETED' ? 'SUPPORT_REQUEST_COMPLETED' : 'SUPPORT_REQUEST_CANCELED');
    return this.detail(actor, id);
  }

  private async event(
    r: { id: string; tenantId: string; customerId: string }, actor: ActorContext, event: string,
    detail: Record<string, unknown>, action: Parameters<AuditService['log']>[0]['action'] | null,
  ) {
    await this.prisma.supportRequestEvent.create({
      data: { requestId: r.id, actorId: actor.userId, event, detail: detail as Prisma.InputJsonValue },
    });
    if (action) {
      await this.audit.log({
        tenantId: r.tenantId, customerId: r.customerId, actorId: actor.userId, actorIp: actor.ip,
        action, resource: 'support_request', resourceId: r.id, meta: detail,
      });
    }
  }

  /** People this request could be handed to: those who can handle requests here now. */
  async handoffCandidates(actor: ActorContext, id: string) {
    const r = await this.load(actor, id);
    const [members, assignments] = await Promise.all([
      this.prisma.membership.findMany({
        where: { customerId: r.customerId, isActive: true, user: { status: 'ACTIVE' } },
        select: { userId: true, user: { select: { firstName: true, lastName: true, email: true } } },
      }),
      this.prisma.technicianAssignment.findMany({
        where: { customerId: r.customerId, revokedAt: null },
        select: {
          userId: true, user: { select: { firstName: true, lastName: true, email: true } },
          group: { select: { members: { select: { userId: true, user: { select: { firstName: true, lastName: true, email: true } } } } } },
        },
      }),
    ]);
    const people = new Map<string, { firstName: string | null; lastName: string | null; email: string }>();
    for (const m of members) people.set(m.userId, m.user);
    for (const a of assignments) {
      if (a.userId && a.user) people.set(a.userId, a.user);
      for (const gm of a.group?.members ?? []) people.set(gm.userId, gm.user);
    }
    const out = [];
    for (const [userId, u] of people) {
      if (userId === r.claimedById) continue;
      if (await this.canHandle(userId, r.customerId)) out.push({ userId, name: this.who(u), email: u.email });
    }
    return out;
  }

  // ── Connect hooks ────────────────────────────────────────────────────────

  /**
   * For Quick Connect from a request: the caller must have claimed it, in
   * the business the session will belong to. Moves CLAIMED → CONNECTING.
   */
  async forQuickConnect(actor: ActorContext, requestId: string) {
    const r = await this.prisma.supportRequest.findFirst({
      where: { id: requestId, customerId: actor.businessId ?? '__none__', claimedById: actor.userId, status: { in: ['CLAIMED', 'CONNECTING'] } },
      select: { id: true },
    });
    if (!r) throw new NotFoundException('Support request not found or not claimed by you');
    await this.prisma.supportRequest.updateMany({ where: { id: r.id, status: 'CLAIMED' }, data: { status: 'CONNECTING' } });
    return r.id;
  }

  // ── Retention ────────────────────────────────────────────────────────────

  async retention(now = new Date()) {
    const expired = await this.prisma.supportRequest.updateMany({
      where: { status: 'WAITING', createdAt: { lt: new Date(now.getTime() - WAITING_EXPIRY_MS) } },
      data: { status: 'EXPIRED', closedAt: now, outcome: 'expired_unclaimed', version: { increment: 1 } },
    });
    const old = await this.prisma.supportRequest.findMany({
      where: { status: { notIn: OPEN }, anonymizedAt: null, closedAt: { lt: new Date(now.getTime() - ANONYMIZE_AFTER_MS) } },
      select: { id: true }, take: 500,
    });
    for (const o of old) {
      await this.prisma.supportRequest.update({
        where: { id: o.id },
        data: {
          contactName: null, contactEmail: null, contactPhone: null, description: null, reportedRustdeskId: null,
          submitIpHash: null, anonymizedAt: now,
          // The status link stops working: its hash no longer matches anything.
          statusTokenHash: sha(randomBytes(32).toString('hex')),
        },
      });
      await this.prisma.supportRequestEvent.updateMany({ where: { requestId: o.id }, data: { detail: Prisma.JsonNull } });
      await this.prisma.supportRequestAttachment.deleteMany({ where: { requestId: o.id } });
    }
    // Screenshots and usage samples never outlive ATTACHMENT_MAX_AGE_MS (0.36),
    // even on a request still open.
    const aged = await this.prisma.supportRequestAttachment.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - ATTACHMENT_MAX_AGE_MS) } } });
    if (aged.count) this.logger.log(`Support requests: ${aged.count} attachment(s) past ${ATTACHMENT_MAX_AGE_MS / 86_400_000} days deleted`);
    if (expired.count || old.length) this.logger.log(`Support requests: ${expired.count} expired, ${old.length} anonymized`);
    return { expired: expired.count, anonymized: old.length };
  }
}
