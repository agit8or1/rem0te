import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ContainmentService } from '../containment/containment.service';
import { pauseMessage } from '../containment/pause';
import { ChatService } from '../chat/chat.service';
import { deviceName } from '../chat/chat-policy';
import { EnrollmentService } from '../enrollment/enrollment.service';
import { SupportRequestsService } from '../support-requests/support-requests.service';
import {
  CODE_TTL_MS, MAX_CODES_PER_10_MIN, SELF_HELP_OUTCOMES, SELF_HELP_PER_HOUR, accent, detailLines, hashMatches, newSecret,
  newTrayKey, parseTrayKey, selfHelpTool, sha256, summaryLine, supportLine, toolsFor, type SelfHelpOutcome,
} from './tray-policy';

/**
 * The tray (0.36): what the tray on a managed Windows computer may ask of the
 * portal, and what a technician sees of it.
 *
 *   device   POST /tray/pair                  device secret, standard agent: issue the tray key
 *            POST /tray/status                device secret (signed) | tray key (standard)
 *            POST /tray/chat-code             …: a one-time /assist code (60 s)
 *            POST /tray/support-requests      …: a support request, optional usage + screenshot
 *            POST /tray/self-help/begin       …: may this tool run now? (catalog, containment, rate)
 *            POST /tray/self-help/result      …: what came of it
 *   portal   GET  /endpoints/:id/tray         computers:view (the device-list visibility rule)
 *            GET|PUT /chat-recording[...]     Business Owner / Platform Admin, fresh auth to change
 *
 * Two credentials, never confused:
 *   signed    the SYSTEM tray host of the signed agent, with the device
 *             secret (secretMatches, through EnrollmentService). Only a
 *             computer on the signed channel is answered this way.
 *   tray_key  a standard computer's tray, with the per-install key its
 *             SYSTEM heartbeat fetched over the device secret (/tray/pair).
 *             Readable by the computer's local users, so it can do only
 *             what the person at the computer can do through the tray —
 *             never an elevated tool, never anything a heartbeat does.
 * The computer is always the one the credential proved; a body never names it.
 */

export type TrayVia = 'signed' | 'tray_key';
export interface TrayDevice {
  endpointId: string;
  tenantId: string | null;
  customerId: string | null;
  via: TrayVia;
}

const SWEEP_MS = 3600_000;
/** Self-help runs are kept this long on the computer's history. */
export const SELF_HELP_RETENTION_DAYS = 400;

@Injectable()
export class TrayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Tray');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly containment: ContainmentService,
    private readonly chat: ChatService,
    private readonly enrollment: EnrollmentService,
    private readonly support: SupportRequestsService,
  ) {}

  onModuleInit() {
    if (process.env.TRAY_SWEEP === 'off') return;
    this.timer = setInterval(() => { void this.sweep(); }, SWEEP_MS);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ── Who is asking ─────────────────────────────────────────────────────────

  /**
   * The computer a tray request is from. A tray key wins if present (and is
   * the only thing a standard computer's tray holds); otherwise the device
   * secret, which is accepted here only from a computer on the signed channel.
   * Every failure is a 401 and an ENDPOINT_HEARTBEAT_REJECTED audit row.
   */
  async identify(body: { trayKey?: string; rustdeskId?: string; agentSecret?: string }): Promise<TrayDevice> {
    if (body.trayKey !== undefined) {
      const k = parseTrayKey(body.trayKey);
      const ep = k ? await this.prisma.endpoint.findUnique({ where: { trayKeyId: k.keyId }, select: { id: true, tenantId: true, customerId: true, trayKeyHash: true, updateChannel: true, status: true } }) : null;
      if (!k || !ep || !hashMatches(ep.trayKeyHash, k.secret) || ep.updateChannel === 'signed' || ep.status === 'ARCHIVED') {
        await this.audit.log({
          tenantId: ep?.tenantId ?? undefined, action: 'ENDPOINT_HEARTBEAT_REJECTED', resource: 'endpoint', resourceId: ep?.id,
          meta: { reason: 'tray_key_unauthenticated' },
        });
        throw new UnauthorizedException('This tray is not recognised');
      }
      return { endpointId: ep.id, tenantId: ep.tenantId, customerId: ep.customerId, via: 'tray_key' };
    }
    const dev = await this.enrollment.authenticateDevice(String(body.rustdeskId ?? ''), body.agentSecret, 'tray_unauthenticated');
    const ep = await this.prisma.endpoint.findUnique({ where: { id: dev.endpointId }, select: { id: true, tenantId: true, customerId: true, updateChannel: true, status: true } });
    if (!ep || ep.status === 'ARCHIVED') throw new NotFoundException('This device is not attached to a computer');
    if (ep.updateChannel !== 'signed') {
      // A standard computer's tray speaks with its tray key; its device secret
      // stays with the SYSTEM heartbeat, which uses it only to pair.
      throw new ForbiddenException({ code: 'TRAY_KEY_REQUIRED', message: 'A standard agent\'s tray authenticates with its tray key.' });
    }
    return { endpointId: ep.id, tenantId: ep.tenantId, customerId: ep.customerId, via: 'signed' };
  }

  /**
   * POST /tray/pair: the standard agent's SYSTEM heartbeat, with the device
   * secret, asks for the tray key. Each call replaces the previous key (the
   * old one stops working at once). Only for a standard computer: the signed
   * agent's tray has no key — its SYSTEM host speaks for it.
   */
  async pair(body: { rustdeskId: string; agentSecret: string }) {
    const dev = await this.enrollment.authenticateDevice(body.rustdeskId, body.agentSecret, 'tray_pair_unauthenticated');
    const ep = await this.prisma.endpoint.findUnique({ where: { id: dev.endpointId }, select: { id: true, tenantId: true, customerId: true, updateChannel: true, trayKeyId: true, status: true } });
    if (!ep || ep.status === 'ARCHIVED') throw new NotFoundException('This device is not attached to a computer');
    if (ep.updateChannel === 'signed') throw new ConflictException({ code: 'TRAY_SIGNED', message: 'The signed agent\'s tray needs no key: the agent speaks for it.' });
    const k = newTrayKey();
    await this.prisma.endpoint.update({ where: { id: ep.id }, data: { trayKeyId: k.keyId, trayKeyHash: k.hash, trayPairedAt: new Date() } });
    await this.audit.log({
      tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined, action: 'TRAY_PAIRED', resource: 'endpoint', resourceId: ep.id,
      meta: { keyId: k.keyId, replaced: !!ep.trayKeyId },
    });
    return { trayKey: k.token, keyId: k.keyId };
  }

  private async context(dev: TrayDevice) {
    const ep = await this.prisma.endpoint.findUniqueOrThrow({
      where: { id: dev.endpointId },
      select: {
        id: true, tenantId: true, customerId: true, updateChannel: true, agentVersion: true,
        customer: { select: { name: true, chatRecording: true } },
        tenant: { select: { name: true, branding: { select: { supportEmail: true, supportPhone: true, accentColor: true } } } },
      },
    });
    return ep;
  }

  private async pauses(customerId: string | null) {
    const [remote, actions] = await Promise.all([this.containment.blocking('remote', customerId), this.containment.blocking('actions', customerId)]);
    return {
      remote: remote ? pauseMessage(remote, 'remote') : null,
      actions: actions ? pauseMessage(actions, 'actions') : null,
    };
  }

  /** The brand the tray and the page show: from the portal's records, never from a device or a message. */
  brand(ep: Awaited<ReturnType<TrayService['context']>>) {
    return {
      businessName: deviceName(ep.customer?.name ?? '') ?? 'Your IT provider',
      providerName: deviceName(ep.tenant?.name ?? '') ?? 'Your IT provider',
      supportText: supportLine(ep.tenant?.branding),
      accent: accent(ep.tenant?.branding?.accentColor),
    };
  }

  // ── POST /tray/status ─────────────────────────────────────────────────────

  async status(dev: TrayDevice, body: { delivered?: unknown; localUser?: unknown }) {
    const localUser = deviceName(body.localUser);
    const ep = await this.context(dev);
    const [chat, contained, recordNew] = await Promise.all([
      this.chat.forTray(dev.endpointId, body.delivered),
      this.pauses(dev.customerId),
      this.chat.recordingFor(ep.customer?.chatRecording),
    ]);
    const c = chat?.conversation;
    const otherUser = !!(c?.deviceUser && localUser && c.deviceUser !== localUser);
    return {
      ...this.brand(ep),
      agent: dev.via === 'signed' ? 'signed' : 'standard',
      hasBusiness: !!dev.customerId,
      // The computer's own business id: the signed tray host matches it against
      // a business-scoped signed pause before an elevated tool runs.
      businessId: dev.customerId,
      chat: c && !otherUser
        ? {
          open: true, conversationId: c.id, startedBy: c.startedBy, recorded: c.recorded, unread: chat!.unread,
          // A technician started it and no window has opened it yet: the tray
          // in the console session opens it, as the 0.34 window did.
          autoOpen: c.startedBy === 'technician' && !c.deviceState,
        }
        : { open: false, otherUser },
      recordNew,
      contained,
      selfHelp: toolsFor(dev.via).map((t) => ({
        id: t.id, title: t.title, elevated: t.elevated,
        blocked: t.blockedBy.map((k) => contained[k]).find(Boolean) ?? null,
      })),
      // While a chat is open the tray asks every 10 s (for its badge); otherwise
      // it learns of a new chat from the heartbeat's signal file.
      pollSeconds: c ? 10 : 600,
    };
  }

  // ── POST /tray/chat-code ──────────────────────────────────────────────────

  /**
   * A one-time code for the /assist page, bound to this computer, to the open
   * conversation if there is one (claimed for this Windows account), and to
   * the account. 60 seconds, exchanged at most once; only its hash is kept.
   * The tray builds the URL itself, from the portal host it was installed
   * against: the response carries the code, never a URL.
   */
  async chatCode(dev: TrayDevice, body: { localUser?: unknown }) {
    const localUser = deviceName(body.localUser);
    const recent = await this.prisma.assistCode.count({ where: { endpointId: dev.endpointId, createdAt: { gt: new Date(Date.now() - 10 * 60_000) } } });
    if (recent >= MAX_CODES_PER_10_MIN) {
      throw new HttpException({ code: 'CHAT_CODE_RATE_LIMITED', message: 'Too many chat windows opened. Wait a few minutes.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const conversationId = await this.chat.bindForUser(dev.endpointId, localUser);
    if (!conversationId && !dev.customerId) {
      throw new ConflictException({ code: 'CHAT_UNSUPPORTED', reason: 'no_business', message: 'This computer is not assigned to a business yet.' });
    }
    const code = newSecret();
    const now = Date.now();
    await this.prisma.assistCode.create({
      data: { codeHash: sha256(code), endpointId: dev.endpointId, conversationId, localUser, via: dev.via, expiresAt: new Date(now + CODE_TTL_MS), createdAt: new Date(now) },
    });
    return { code, expiresAt: new Date(now + CODE_TTL_MS), conversationId };
  }

  // ── POST /tray/support-requests ───────────────────────────────────────────

  async supportRequest(dev: TrayDevice, body: { description?: unknown; localUser?: unknown; usage?: unknown; screenshot?: unknown }) {
    return this.support.agentSubmit({ id: dev.endpointId, tenantId: dev.tenantId, customerId: dev.customerId }, {
      description: body.description, localUser: deviceName(body.localUser), usage: body.usage, screenshot: body.screenshot, via: dev.via,
    });
  }

  // ── POST /tray/self-help/* ────────────────────────────────────────────────

  /**
   * May this tool run now? The closed catalog (an unknown id is refused), the
   * credential (a tray key never runs an elevated tool), containment (an
   * `actions` pause stops every elevated tool; `remote` also stops the
   * RustDesk restart) and the per-computer rate. A run refused for
   * containment is still recorded, so the history says someone tried.
   */
  async selfHelpBegin(dev: TrayDevice, body: { tool?: unknown; localUser?: unknown }) {
    const t = selfHelpTool(body.tool);
    if (!t) throw new BadRequestException({ code: 'SELF_HELP_UNKNOWN', message: 'That is not one of the self-help tools.' });
    if (t.elevated && dev.via !== 'signed') {
      throw new ForbiddenException({ code: 'SELF_HELP_SIGNED_ONLY', message: 'This tool needs the signed agent: it runs as the system, and the standard agent\'s tray cannot ask for that.' });
    }
    const localUser = deviceName(body.localUser);
    const base = { tenantId: dev.tenantId, customerId: dev.customerId, endpointId: dev.endpointId, tool: t.id, localUser, via: dev.via };
    for (const kind of t.blockedBy) {
      const p = await this.containment.blocking(kind, dev.customerId);
      if (p) {
        const run = await this.prisma.traySelfHelpRun.create({ data: { ...base, status: 'refused', summary: 'Paused by your IT provider (containment).', finishedAt: new Date() }, select: { id: true } });
        await this.auditRun(dev, run.id, t.id, 'refused', false);
        throw new ForbiddenException({ code: 'CONTAINED', message: pauseMessage(p, kind), pauseId: p.id });
      }
    }
    const now = Date.now();
    const [inWindow, inHour] = await Promise.all([
      this.prisma.traySelfHelpRun.count({ where: { endpointId: dev.endpointId, tool: t.id, status: { not: 'refused' }, startedAt: { gt: new Date(now - t.windowMs) } } }),
      this.prisma.traySelfHelpRun.count({ where: { endpointId: dev.endpointId, status: { not: 'refused' }, startedAt: { gt: new Date(now - 3600_000) } } }),
    ]);
    if (inWindow >= t.perWindow || inHour >= SELF_HELP_PER_HOUR) {
      throw new HttpException({ code: 'SELF_HELP_RATE_LIMITED', message: `"${t.title}" has run too often on this computer. Try again later.` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    const run = await this.prisma.traySelfHelpRun.create({ data: { ...base, status: 'running' }, select: { id: true } });
    return { runId: run.id, tool: t.id };
  }

  /**
   * What came of a run: the one begin() approved (by its id, this computer
   * only, once), or — `offline: true` — one the signed agent ran while the
   * portal could not be reached (a renewed address is exactly that case) and
   * reports afterwards. Offline reports are bounded: within 7 days, at most
   * 20 a day per computer, and never an elevated tool from a tray key.
   */
  async selfHelpResult(dev: TrayDevice, body: { runId?: unknown; tool?: unknown; outcome?: unknown; summary?: unknown; detail?: unknown; offline?: unknown; ranAt?: unknown; localUser?: unknown }) {
    const outcome = (SELF_HELP_OUTCOMES as readonly string[]).includes(String(body.outcome)) ? (body.outcome as SelfHelpOutcome) : null;
    if (!outcome) throw new BadRequestException({ code: 'SELF_HELP_OUTCOME', message: 'outcome must be succeeded, failed or refused' });
    const result = { status: outcome, summary: summaryLine(body.summary), detail: detailLines(body.detail) as unknown as Prisma.InputJsonValue, finishedAt: new Date() };
    if (typeof body.runId === 'string' && body.runId) {
      const r = await this.prisma.traySelfHelpRun.updateMany({ where: { id: body.runId, endpointId: dev.endpointId, status: 'running' }, data: result });
      if (r.count !== 1) throw new NotFoundException('Run not found');
      const run = await this.prisma.traySelfHelpRun.findUniqueOrThrow({ where: { id: body.runId }, select: { tool: true } });
      await this.auditRun(dev, body.runId, run.tool, outcome, false);
      return { recorded: true };
    }
    if (body.offline !== true) throw new BadRequestException({ code: 'SELF_HELP_NO_RUN', message: 'A result names the run it is for, or says it ran offline.' });
    const t = selfHelpTool(body.tool);
    if (!t) throw new BadRequestException({ code: 'SELF_HELP_UNKNOWN', message: 'That is not one of the self-help tools.' });
    if (t.elevated && dev.via !== 'signed') throw new ForbiddenException({ code: 'SELF_HELP_SIGNED_ONLY', message: 'This tool needs the signed agent.' });
    const ranAt = typeof body.ranAt === 'string' ? new Date(body.ranAt) : null;
    const now = Date.now();
    if (!ranAt || Number.isNaN(ranAt.getTime()) || ranAt.getTime() > now + 60_000 || ranAt.getTime() < now - 7 * 86_400_000) {
      throw new BadRequestException({ code: 'SELF_HELP_RAN_AT', message: 'ranAt must be within the last 7 days' });
    }
    const today = await this.prisma.traySelfHelpRun.count({ where: { endpointId: dev.endpointId, offline: true, finishedAt: { gt: new Date(now - 86_400_000) } } });
    if (today >= 20) throw new HttpException({ code: 'SELF_HELP_RATE_LIMITED', message: 'Too many offline reports today.' }, HttpStatus.TOO_MANY_REQUESTS);
    const run = await this.prisma.traySelfHelpRun.create({
      data: { tenantId: dev.tenantId, customerId: dev.customerId, endpointId: dev.endpointId, tool: t.id, localUser: deviceName(body.localUser), via: dev.via, offline: true, startedAt: ranAt, ...result },
      select: { id: true },
    });
    await this.auditRun(dev, run.id, t.id, outcome, true);
    return { recorded: true, runId: run.id };
  }

  /** The audit row: which tool and what came of it. Never the Windows account, never the output. */
  private auditRun(dev: TrayDevice, runId: string, tool: string, outcome: string, offline: boolean) {
    return this.audit.log({
      tenantId: dev.tenantId ?? undefined, customerId: dev.customerId ?? undefined, action: 'TRAY_SELF_HELP', resource: 'endpoint', resourceId: dev.endpointId,
      meta: { runId, tool, outcome, offline },
    });
  }

  // ── GET /endpoints/:id/tray ───────────────────────────────────────────────

  /**
   * What a technician sees of the tray on one computer: whether it has one,
   * the self-help runs (what, when, which Windows account, the result) and
   * the support requests it sent. The visibility rule AND-ed with the id; a
   * computer the caller cannot see is a 404.
   */
  async endpointTray(actor: ActorContext, endpointId: string) {
    await this.acl.assertEndpointInScope(actor, endpointId, CAP.COMPUTERS_VIEW);
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [this.acl.endpointVisibilityWhere(actor), { id: endpointId }] },
      select: { id: true, platform: true, updateChannel: true, chatProtocol: true, trayProtocol: true, trayKeyId: true, trayPairedAt: true },
    });
    if (!ep) throw new NotFoundException('Computer not found');
    const windows = /^windows/i.test(ep.platform ?? '');
    const kind = !windows ? 'unsupported'
      : ep.updateChannel === 'signed' ? ((ep.trayProtocol ?? 0) >= 1 ? 'signed' : 'none')
        : (ep.trayProtocol ?? 0) >= 1 && ep.trayKeyId ? 'standard' : 'none';
    const message = kind === 'unsupported'
      ? 'Linux and macOS have no tray yet.'
      : kind === 'signed' ? 'The signed agent starts the tray in every signed-in session. All six self-help tools are available.'
        : kind === 'standard' ? 'The standard agent installed the tray; it starts at sign-in. Only the three read-only self-help tools are available on the standard agent.'
          : ep.updateChannel === 'signed' ? 'This signed agent is older than 0.36 and has no tray. It gains one with its next update.'
            : 'No tray yet. Re-run the installer from this portal to add it; it starts at the next sign-in.';
    const [runs, requests] = await Promise.all([
      this.prisma.traySelfHelpRun.findMany({
        where: { endpointId }, orderBy: { startedAt: 'desc' }, take: 50,
        select: { id: true, tool: true, localUser: true, via: true, status: true, offline: true, summary: true, detail: true, startedAt: true, finishedAt: true },
      }),
      this.acl.can(actor, CAP.SUPPORT_REQUESTS)
        ? this.prisma.supportRequest.findMany({
          where: { endpointId, origin: 'AGENT', anonymizedAt: null }, orderBy: { createdAt: 'desc' }, take: 10,
          select: { id: true, status: true, createdAt: true, contactName: true, _count: { select: { attachments: true } } },
        })
        : Promise.resolve(null),
    ]);
    return { tray: { kind, protocol: ep.trayProtocol, pairedAt: ep.trayPairedAt, message }, selfHelp: runs, requests };
  }

  // ── Chat recording settings ───────────────────────────────────────────────

  async recordingSettings(actor: ActorContext, businessId?: string) {
    const p = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { chatRecordingDefault: true } });
    const platformDefault = p?.chatRecordingDefault !== false;
    const id = this.acl.resolveScope(actor, businessId);
    const c = id ? await this.prisma.customer.findUnique({ where: { id }, select: { id: true, name: true, chatRecording: true } }) : null;
    return {
      platformDefault,
      canChangePlatform: actor.isPlatformAdmin,
      business: c ? { id: c.id, name: c.name, setting: c.chatRecording, effective: c.chatRecording ?? platformDefault, canChange: this.ownsBusiness(actor, c.id) } : null,
    };
  }

  private ownsBusiness(actor: ActorContext, businessId: string) {
    if (actor.technician) return false;
    if (actor.isPlatformAdmin) return true;
    return this.acl.isBusinessOwner(actor) && actor.businessId === businessId;
  }

  /** PUT /chat-recording { businessId?, recording: true | false | null }. Fresh authentication is checked by the controller. */
  async setBusinessRecording(actor: ActorContext, businessId: string | undefined, recording: boolean | null) {
    const id = this.acl.requireScope(actor, businessId);
    if (!this.ownsBusiness(actor, id)) throw new ForbiddenException('Only a Business Owner or a Platform Admin can change whether chats are recorded');
    const before = await this.prisma.customer.findUniqueOrThrow({ where: { id }, select: { chatRecording: true, tenantId: true } });
    await this.prisma.customer.update({ where: { id }, data: { chatRecording: recording } });
    await this.audit.log({
      tenantId: before.tenantId, customerId: id, actorId: actor.userId, actorIp: actor.ip,
      action: 'CHAT_RECORDING_CHANGED', resource: 'customer', resourceId: id,
      meta: { scope: 'business', before: before.chatRecording, after: recording },
    });
    return this.recordingSettings(actor, id);
  }

  /** PUT /chat-recording/platform { recording }. Platform Admin; fresh authentication checked by the controller. */
  async setPlatformRecording(actor: ActorContext, recording: boolean) {
    this.acl.assertPlatformAdmin(actor);
    const before = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { chatRecordingDefault: true } });
    await this.prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: { chatRecordingDefault: recording }, create: { id: 'singleton', chatRecordingDefault: recording } });
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'CHAT_RECORDING_CHANGED', resource: 'platform_settings', resourceId: 'singleton',
      meta: { scope: 'platform', before: before?.chatRecordingDefault ?? true, after: recording },
    });
    return this.recordingSettings(actor);
  }

  // ── Sweep ─────────────────────────────────────────────────────────────────

  /** Expired codes and sessions go; self-help runs older than 400 days go. Nothing in the audit log is touched. */
  async sweep(now = new Date()) {
    try {
      const [codes, sessions, runs] = await Promise.all([
        this.prisma.assistCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 3600_000) } } }),
        this.prisma.assistSession.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 3600_000) } } }),
        this.prisma.traySelfHelpRun.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - SELF_HELP_RETENTION_DAYS * 86_400_000) } } }),
      ]);
      // A run the agent never reported on is closed as failed after an hour.
      await this.prisma.traySelfHelpRun.updateMany({ where: { status: 'running', startedAt: { lt: new Date(now.getTime() - 3600_000) } }, data: { status: 'failed', summary: 'The agent never reported a result.', finishedAt: now } });
      return { codes: codes.count, sessions: sessions.count, runs: runs.count };
    } catch (e) {
      this.logger.warn(`tray sweep failed: ${String(e)}`);
      return null;
    }
  }
}
