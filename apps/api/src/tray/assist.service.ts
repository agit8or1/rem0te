import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ContainmentService } from '../containment/containment.service';
import { pauseMessage } from '../containment/pause';
import { ChatService } from '../chat/chat.service';
import { chatText, isClientId } from '../chat/chat-policy';
import { SupportRequestsService } from '../support-requests/support-requests.service';
import { TrayService } from './tray.service';
import { SESSION_TTL_MS, isCode, newSecret, readAssistCookie, sha256 } from './tray-policy';

/**
 * The /assist page's side (0.36). Its only credential is the cookie that
 * exchange() set — HttpOnly, Secure, SameSite=Strict, Path=/assist — for one
 * computer and at most one conversation, for at most two hours. It is not a
 * portal session and opens nothing else: no route outside /assist reads it.
 *
 *   exchange  the code from the tray's URL, consumed with one conditional
 *             update (unused, unexpired → used). A second use, a guessed
 *             code or an expired one is the same refusal, and the code
 *             cannot be replayed from browser history once it worked.
 *   state     the conversation this session is bound to — binding, on first
 *             sight, to the open one if it is this Windows account's.
 *   start     a chat the person starts (no conversation yet), with a
 *             support request in the queue so a technician sees it.
 *   messages  a reply (the 0.34 device reply rules: length, rate, client id).
 *   receipts  shown / read for technician messages, only what the page says.
 *   end       the person ends the chat.
 */
@Injectable()
export class AssistService {
  private readonly logger = new Logger('Assist');

  constructor(
    private readonly prisma: PrismaService,
    private readonly containment: ContainmentService,
    private readonly chat: ChatService,
    private readonly support: SupportRequestsService,
    private readonly tray: TrayService,
  ) {}

  /** The code → a session token, or null. One conditional update decides; nothing is read first. */
  async exchange(code: unknown): Promise<string | null> {
    if (!isCode(code)) return null;
    const now = new Date();
    const hash = sha256(code);
    const claimed = await this.prisma.assistCode.updateMany({ where: { codeHash: hash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimed.count !== 1) return null;
    const c = await this.prisma.assistCode.findUniqueOrThrow({ where: { codeHash: hash } });
    const token = newSecret();
    await this.prisma.assistSession.create({
      data: {
        tokenHash: sha256(token), endpointId: c.endpointId, conversationId: c.conversationId, localUser: c.localUser, via: c.via,
        createdAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      },
    });
    return token;
  }

  /** The session the cookie names, live and unrevoked, on a computer that still exists — else 401. */
  async session(cookieHeader: string | undefined) {
    const token = readAssistCookie(cookieHeader);
    if (!token) throw new UnauthorizedException({ code: 'ASSIST_EXPIRED', message: 'This chat window has expired. Open the chat again from the tray icon.' });
    const s = await this.prisma.assistSession.findFirst({
      where: { tokenHash: sha256(token), revokedAt: null, expiresAt: { gt: new Date() }, endpoint: { status: { not: 'ARCHIVED' } } },
    });
    if (!s) throw new UnauthorizedException({ code: 'ASSIST_EXPIRED', message: 'This chat window has expired. Open the chat again from the tray icon.' });
    return s;
  }

  private async endpoint(endpointId: string) {
    return this.prisma.endpoint.findUniqueOrThrow({
      where: { id: endpointId },
      select: {
        id: true, tenantId: true, customerId: true, updateChannel: true, agentVersion: true,
        customer: { select: { name: true, chatRecording: true } },
        tenant: { select: { name: true, branding: { select: { supportEmail: true, supportPhone: true, accentColor: true } } } },
      },
    });
  }

  /** Bind an unbound session to the open conversation if it is this account's (or nobody's yet). */
  private async conversationFor(s: Awaited<ReturnType<AssistService['session']>>): Promise<string | null> {
    if (s.conversationId) return s.conversationId;
    const open = await this.prisma.chatConversation.findFirst({ where: { endpointId: s.endpointId, status: 'OPEN' }, select: { id: true, deviceUser: true } });
    if (!open) return null;
    if (open.deviceUser && s.localUser && open.deviceUser !== s.localUser) return null;
    await this.prisma.assistSession.updateMany({ where: { id: s.id, conversationId: null }, data: { conversationId: open.id } });
    const again = await this.prisma.assistSession.findUniqueOrThrow({ where: { id: s.id }, select: { conversationId: true } });
    if (again.conversationId === open.id && !open.deviceUser && s.localUser) {
      await this.prisma.chatConversation.updateMany({ where: { id: open.id, deviceUser: null }, data: { deviceUser: s.localUser } });
    }
    return again.conversationId;
  }

  async state(cookie: string | undefined) {
    const s = await this.session(cookie);
    const ep = await this.endpoint(s.endpointId);
    const cid = await this.conversationFor(s);
    const view = cid ? await this.chat.assistView(s.endpointId, cid) : null;
    const remote = await this.containment.blocking('remote', ep.customerId);
    const brand = this.tray.brand(ep);
    return {
      ...brand,
      retentionDays: this.chat.config.retentionDays,
      recordNew: await this.chat.recordingFor(ep.customer?.chatRecording),
      contained: remote ? pauseMessage(remote, 'remote') : null,
      canStart: !view && !!ep.customerId && !remote,
      startBlocked: !ep.customerId ? 'This computer is not assigned to a business yet, so a chat cannot be started from here.' : null,
      conversation: view?.conversation ?? null,
      messages: view?.messages ?? [],
    };
  }

  /**
   * The person starts a chat: a support request in the queue (so a
   * technician sees it — its description is a fixed sentence, never the
   * message, which would outlive an unrecorded chat), then the conversation,
   * then the first message. If a technician opened one meanwhile, the
   * message goes there instead.
   */
  async start(cookie: string | undefined, body: { text?: unknown; clientId?: unknown }) {
    const s = await this.session(cookie);
    if (s.conversationId) throw new ConflictException({ code: 'CHAT_ALREADY', message: 'This window already has a chat.' });
    const t = chatText(body?.text);
    if (!t.ok) throw new BadRequestException({ code: t.code === 'TOO_LONG' ? 'CHAT_TOO_LONG' : 'CHAT_EMPTY', message: 'A message must be 1 to 2,000 characters.' });
    if (!isClientId(body?.clientId)) throw new BadRequestException('clientId is required');
    const ep = await this.endpoint(s.endpointId);
    await this.containment.assertOpen('remote', ep.customerId);
    let requestId: string | null = null;
    const already = await this.prisma.chatConversation.findFirst({ where: { endpointId: s.endpointId, status: 'OPEN' }, select: { id: true } });
    if (!already) {
      try {
        const r = await this.support.agentSubmit(
          { id: ep.id, tenantId: ep.tenantId, customerId: ep.customerId },
          { localUser: s.localUser, via: s.via as 'signed' | 'tray_key' },
          { fixedDescription: 'The person at this computer started a chat from the tray. Open the computer\'s Chat tab to answer.', fromChat: true },
        );
        requestId = r.id;
      } catch (e) {
        // A full queue or the hourly cap does not stop the chat; it only means no new queue entry.
        this.logger.log(`tray chat start without a support request: ${String((e as Error)?.message ?? e)}`);
      }
    }
    const conv = await this.chat.endUserStart(
      { id: ep.id, tenantId: ep.tenantId, customerId: ep.customerId, customerName: ep.customer?.name ?? null, customerRecording: ep.customer?.chatRecording ?? null },
      s.localUser, requestId,
    );
    if (conv.existing && requestId) {
      await this.prisma.chatConversation.updateMany({ where: { id: conv.id, supportRequestId: null }, data: { supportRequestId: requestId } });
    }
    const bound = await this.prisma.assistSession.updateMany({ where: { id: s.id, conversationId: null }, data: { conversationId: conv.id } });
    if (bound.count !== 1) throw new ConflictException({ code: 'CHAT_ALREADY', message: 'This window already has a chat.' });
    const m = await this.chat.deviceReply(s.endpointId, { conversationId: conv.id, clientId: body.clientId as string, text: body.text as string });
    return { conversationId: conv.id, messageId: m.id };
  }

  private async bound(cookie: string | undefined) {
    const s = await this.session(cookie);
    const cid = await this.conversationFor(s);
    if (!cid) throw new NotFoundException({ code: 'CHAT_NONE', message: 'There is no chat in this window yet.' });
    return { s, cid };
  }

  async send(cookie: string | undefined, body: { text?: unknown; clientId?: unknown }) {
    const { s, cid } = await this.bound(cookie);
    if (!isClientId(body?.clientId) || typeof body?.text !== 'string') throw new BadRequestException('clientId and text are required');
    return this.chat.deviceReply(s.endpointId, { conversationId: cid, clientId: body.clientId, text: body.text });
  }

  async receipts(cookie: string | undefined, body: { shown?: unknown; read?: unknown }) {
    const { s, cid } = await this.bound(cookie);
    return this.chat.assistReceipts(s.endpointId, cid, body);
  }

  async end(cookie: string | undefined) {
    const { s, cid } = await this.bound(cookie);
    return this.chat.assistEnd(s.endpointId, cid);
  }
}
