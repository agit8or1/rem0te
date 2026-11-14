import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger,
  NotFoundException, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { Prisma, type ChatConversation, type ChatMessage } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, technicianGrantAllows, type ActorContext } from '../rbac/access-control.service';
import { CAP, type Capability } from '../rbac/capabilities';
import { ContainmentService } from '../containment/containment.service';
import { pauseMessage } from '../containment/pause';
import {
  INACTIVE_MS, MAX_DEVICE_PER_MINUTE, MAX_MESSAGES_PER_CONVERSATION, MAX_PER_MINUTE, POLL_BATCH, POLL_HOLD_MS,
  MAX_MESSAGE_CHARS, POLL_RECHECK_MS, TRANSCRIPT_PAGE, chatConfig, chatSupport, chatText, deviceName, deviceState, idList, isId,
  presence, receipt, retentionCutoff, technicianDisplayName, type ChatSweepConfig,
} from './chat-policy';
import { chatRecorded } from '../tray/tray-policy';
import {
  MAX_ATTACHMENTS_PER_CONVERSATION, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_BYTES_PER_CONVERSATION, attachmentBody, checkAttachment,
  type AttachmentCheck,
} from './chat-attachment';

/** What a message says about its attachment: never the bytes. */
const ATTACHMENT_META = { select: { id: true, fileName: true, kind: true, contentType: true, sizeBytes: true } } as const;
type AttachmentMeta = { id: string; fileName: string; kind: string; contentType: string; sizeBytes: number };
type MessageRow = ChatMessage & { attachment?: AttachmentMeta | null };
/** An upload as multer hands it over (memory storage). */
export type UploadedChatFile = { buffer?: Buffer; originalname?: string; size?: number } | undefined;

/** The technician name an end-user-started chat shows until a technician first writes. */
export const AWAITING_TECHNICIAN = 'Waiting for a technician';

/**
 * Chat (0.34): a technician in the portal and the person at a managed
 * Windows computer.
 *
 *   technician  GET  /endpoints/:id/chat                              computers:view
 *               GET  /endpoints/:id/chat/conversations/:cid           computers:view
 *               POST /endpoints/:id/chat/conversations                support:chat
 *               POST /endpoints/:id/chat/conversations/:cid/messages  support:chat
 *               POST /endpoints/:id/chat/conversations/:cid/end       support:chat
 *   heartbeat   chat: { open }  (authenticated signed agent reporting a chat protocol)
 *   agent       POST /enrollment/chat/poll   long-poll ≤ 25 s, device secret
 *               POST /enrollment/chat/reply  device secret
 *   sweep       ends conversations quiet for 2 h; deletes those ended over
 *               400 days ago (CHAT_RETENTION_SWEEP=off stops it)
 *   tray (0.36) the /assist page and the tray reach the same conversation
 *               through TrayService / AssistService; the panel's ack route
 *               POST /endpoints/:id/chat/conversations/:cid/ack (support:chat)
 *   files (0.44) POST /endpoints/:id/chat/conversations/:cid/attachments      support:chat
 *               GET  /endpoints/:id/chat/conversations/:cid/attachments/:aid computers:view
 *               and the page's POST/GET /assist/api/attachments (its cookie).
 *               Classified by magic bytes (chat-attachment.ts); an attachment
 *               is a message whose body is its sanitised name, so it rides
 *               every existing path — rate caps, receipts, recording.
 *
 * Recording (0.36): a conversation is `recorded` or not, frozen when it
 * starts from the business's setting (or the platform default). One that is
 * not keeps no transcript: a technician message is deleted once the page
 * reports it read, a reply once a technician's panel confirms it showed it,
 * and whatever is left when the chat ends.
 *
 * Every technician route starts from assertEndpointInScope AND
 * endpointVisibilityWhere; another business's computer is a 404. A
 * containment pause on `remote` stops new chats and new technician messages.
 * The audit log gets the start and the end with ids and counts — never text.
 *
 * Delivery is never inferred: a technician message is "sent" when stored,
 * and "delivered", "shown" and "read" only when the agent's poll says so.
 */

type Waiter = { wake: () => void };

/** An attachment as both sides' readers see it: its id, name, kind, type and size — the bytes are a separate request. */
function attachmentView(a: AttachmentMeta) {
  return { id: a.id, fileName: a.fileName, kind: a.kind as 'image' | 'file', contentType: a.contentType, sizeBytes: a.sizeBytes };
}

const ATTACHMENT_REFUSAL: Record<string, { status: number; message: string }> = {
  ATTACHMENT_MISSING: { status: 400, message: 'Choose a file to send.' },
  ATTACHMENT_EMPTY: { status: 400, message: 'That file is empty.' },
  ATTACHMENT_TOO_LARGE: { status: 413, message: 'A file can be at most 10 MB.' },
  ATTACHMENT_COUNT: { status: 409, message: `A chat can hold at most ${MAX_ATTACHMENTS_PER_CONVERSATION} files. End it and start another.` },
  ATTACHMENT_TOTAL: { status: 409, message: 'This chat already holds 50 MB of files, the most one chat can.' },
};
function refuseAttachment(code: string): never {
  const r = ATTACHMENT_REFUSAL[code] ?? { status: 400, message: 'The file could not be sent.' };
  throw new HttpException({ code, message: r.message }, r.status);
}
function attachmentOrThrow(a: AttachmentCheck): Extract<AttachmentCheck, { ok: true }> {
  if (!a.ok) refuseAttachment(a.code);
  return a;
}

const CONV_SUMMARY = {
  id: true, status: true, startedById: true, technicianName: true, businessName: true, supportRequestId: true,
  deviceState: true, deviceDetail: true, deviceUser: true, deviceStateAt: true, deviceSeenAt: true, lastActivityAt: true,
  endedAt: true, endedById: true, endedReason: true, technicianMessages: true, endUserMessages: true, createdAt: true,
  startedBy: true, recorded: true,
} satisfies Prisma.ChatConversationSelect;

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Chat');
  private readonly cfg: ChatSweepConfig = chatConfig(process.env);
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  /** One held poll per computer; a newer poll from the same computer releases the older one. */
  private readonly waiters = new Map<string, Waiter>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
    private readonly containment: ContainmentService,
  ) {}

  onModuleInit() {
    if (!this.cfg.enabled) return;
    const every = this.cfg.sweepSeconds * 1000;
    this.first = setTimeout(() => { void this.sweep(); }, Math.min(30_000, every));
    this.timer = setInterval(() => { void this.sweep(); }, every);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    for (const w of this.waiters.values()) w.wake();
  }

  get config(): ChatSweepConfig { return this.cfg; }
  /** Held polls right now (for the sizing note and the e2e). */
  get heldPolls(): number { return this.waiters.size; }

  // ── Scope ─────────────────────────────────────────────────────────────────

  /**
   * The computer, if the caller may see it: business scope and technician
   * grant (assertEndpointInScope, for `capability`) AND the device-list
   * visibility rule. Any failure is the same 404 as a missing id.
   */
  private async visibleEndpoint(actor: ActorContext, endpointId: string, capability: Capability = CAP.COMPUTERS_VIEW) {
    await this.acl.assertEndpointInScope(actor, endpointId, capability);
    const ep = await this.prisma.endpoint.findFirst({
      where: { AND: [this.acl.endpointVisibilityWhere(actor), { id: endpointId }] },
      select: {
        id: true, tenantId: true, customerId: true, status: true, platform: true, updateChannel: true, chatProtocol: true,
        trayProtocol: true, trayKeyId: true,
        customer: { select: { name: true, chatRecording: true } },
        rustdeskNode: { select: { agentSecretHash: true } },
        inventory: { select: { loggedOnUser: true, liveSampledAt: true } },
      },
    });
    if (!ep) throw new NotFoundException('Computer not found');
    return ep;
  }

  private support(ep: Awaited<ReturnType<ChatService['visibleEndpoint']>>) {
    if (!ep.customerId) {
      return { supported: false as const, reason: 'no_business' as const, message: 'Assign this computer to a business first: the chat window shows the business name.' };
    }
    return chatSupport({ ...ep, agentBound: !!ep.rustdeskNode?.agentSecretHash, trayPaired: !!ep.trayKeyId });
  }

  /** Whether a chat started now is recorded: the business's choice, else the platform default. */
  async recordingFor(customerChoice: boolean | null | undefined): Promise<boolean> {
    if (customerChoice === true || customerChoice === false) return customerChoice;
    const p = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { chatRecordingDefault: true } });
    return chatRecorded(customerChoice, p?.chatRecordingDefault);
  }

  /** May this actor write in chats on this computer? The same test assertEndpointInScope makes, without throwing. */
  private maySend(actor: ActorContext, endpointId: string): boolean {
    if (!this.acl.can(actor, CAP.CHAT_SEND)) return false;
    if (actor.technician) return technicianGrantAllows(actor.technician, CAP.CHAT_SEND, endpointId);
    return true;
  }

  private conversationView(c: Pick<ChatConversation, keyof typeof CONV_SUMMARY>, now = Date.now(), via: 'window' | 'tray' = 'window') {
    return { ...c, presence: presence(c, now, via) };
  }

  private messageView(m: MessageRow) {
    return {
      id: m.id, sender: m.sender, authorName: m.authorName, body: m.body, createdAt: m.createdAt,
      deliveredAt: m.deliveredAt, shownAt: m.shownAt, readAt: m.readAt, technicianSeenAt: m.technicianSeenAt, receipt: receipt(m),
      attachment: m.attachment ? attachmentView(m.attachment) : null,
    };
  }

  // ── Technician side ───────────────────────────────────────────────────────

  /** GET /endpoints/:id/chat: can this computer chat, may I, is anything paused, and its conversations. */
  async overview(actor: ActorContext, endpointId: string) {
    const ep = await this.visibleEndpoint(actor, endpointId);
    const [rows, pause] = await Promise.all([
      this.prisma.chatConversation.findMany({ where: { endpointId }, orderBy: { createdAt: 'desc' }, take: 25, select: CONV_SUMMARY }),
      ep.customerId ? this.containment.blocking('remote', ep.customerId) : Promise.resolve(null),
    ]);
    const now = Date.now();
    const open = rows.find((r) => r.status === 'OPEN') ?? null;
    const support = this.support(ep);
    const via = support.supported ? support.via : 'window';
    return {
      support,
      // What a chat started now would be: recorded or not (0.36).
      recordNew: await this.recordingFor(ep.customer?.chatRecording),
      canSend: this.maySend(actor, endpointId),
      contained: pause ? { pauseId: pause.id, message: pauseMessage(pause, 'remote') } : null,
      // What the last heartbeat said about who is signed in — a hint only; the
      // chat window's own report (presence) is what counts.
      lastSignedInUser: ep.inventory?.liveSampledAt ? { name: ep.inventory.loggedOnUser || null, at: ep.inventory.liveSampledAt } : null,
      open: open ? this.conversationView(open, now, via) : null,
      conversations: rows.map((r) => this.conversationView(r, now, via)),
      limits: {
        maxChars: MAX_MESSAGE_CHARS, perMinute: MAX_PER_MINUTE.technician, retentionDays: this.cfg.retentionDays,
        attachmentBytes: MAX_ATTACHMENT_BYTES, attachmentsPerChat: MAX_ATTACHMENTS_PER_CONVERSATION, attachmentBytesPerChat: MAX_ATTACHMENT_BYTES_PER_CONVERSATION,
      },
    };
  }

  /** GET /endpoints/:id/chat/conversations/:cid[?after=messageId]: the transcript, oldest first. */
  async transcript(actor: ActorContext, endpointId: string, conversationId: string, after?: string) {
    const ep = await this.visibleEndpoint(actor, endpointId);
    const c = await this.prisma.chatConversation.findFirst({ where: { id: conversationId, endpointId }, select: CONV_SUMMARY });
    if (!c) throw new NotFoundException('Conversation not found');
    const sup = this.support(ep);
    let since: Date | undefined;
    if (after !== undefined) {
      if (!isId(after)) throw new BadRequestException('after must be a message id');
      const m = await this.prisma.chatMessage.findFirst({ where: { id: after, conversationId }, select: { createdAt: true } });
      since = m?.createdAt;
    }
    // A page of the newest, returned oldest first. `after` is for display
    // only: the receipts on older messages change, so the panel re-reads
    // the whole page on each poll rather than only what is new.
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId, ...(since ? { createdAt: { gte: since } } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: TRANSCRIPT_PAGE,
      include: { attachment: ATTACHMENT_META },
    });
    rows.reverse();
    return {
      conversation: this.conversationView(c, Date.now(), sup.supported ? sup.via : 'window'),
      messages: rows.map((m) => this.messageView(m)),
      truncated: rows.length === TRANSCRIPT_PAGE,
      // Not recorded (0.36): what is here is only what has not yet reached both sides.
      recorded: c.recorded,
    };
  }

  /** POST /endpoints/:id/chat/conversations: open a chat window on the computer (or return the one already open). */
  async start(actor: ActorContext, endpointId: string, body: { supportRequestId?: unknown }) {
    const ep = await this.visibleEndpoint(actor, endpointId, CAP.CHAT_SEND);
    const support = this.support(ep);
    if (!support.supported) throw new ConflictException({ code: 'CHAT_UNSUPPORTED', reason: support.reason, message: support.message });
    await this.containment.assertOpen('remote', ep.customerId);

    let supportRequestId: string | null = null;
    if (body?.supportRequestId !== undefined && body.supportRequestId !== null && body.supportRequestId !== '') {
      if (!isId(body.supportRequestId)) throw new BadRequestException('supportRequestId must be an id');
      // Linking names a request in the queue, so it needs the queue's capability.
      if (!this.acl.can(actor, CAP.SUPPORT_REQUESTS)) throw new ForbiddenException('Linking a support request needs "Handle support requests"');
      const sr = await this.prisma.supportRequest.findFirst({
        where: { id: body.supportRequestId, customerId: ep.customerId!, OR: [{ endpointId: null }, { endpointId }] },
        select: { id: true },
      });
      if (!sr) throw new NotFoundException('Support request not found');
      supportRequestId = sr.id;
    }

    const existing = await this.prisma.chatConversation.findFirst({ where: { endpointId, status: 'OPEN' }, select: CONV_SUMMARY });
    if (existing) return { conversation: this.conversationView(existing), existing: true };

    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true } });
    const technicianName = technicianDisplayName(user ?? {});
    const businessName = deviceName(ep.customer?.name ?? '') ?? 'Your IT provider';
    const recorded = await this.recordingFor(ep.customer?.chatRecording);
    try {
      const conv = await this.prisma.$transaction(async (tx) => {
        const c = await tx.chatConversation.create({
          data: { tenantId: ep.tenantId, customerId: ep.customerId, endpointId, supportRequestId, startedById: actor.userId, startedBy: 'technician', technicianName, businessName, recorded },
          select: CONV_SUMMARY,
        });
        await tx.activityLog.create({
          data: this.audit.entry({
            tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip,
            action: 'CHAT_STARTED', resource: 'endpoint', resourceId: endpointId,
            meta: { conversationId: c.id, recorded, ...(supportRequestId ? { supportRequestId } : {}) },
          }),
        });
        return c;
      });
      this.wake(endpointId);
      return { conversation: this.conversationView(conv), existing: false };
    } catch (e) {
      // Two starts at once: the partial unique index lets one through.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const c = await this.prisma.chatConversation.findFirst({ where: { endpointId, status: 'OPEN' }, select: CONV_SUMMARY });
        if (c) return { conversation: this.conversationView(c), existing: true };
      }
      throw e;
    }
  }

  private async openConversation(endpointId: string, conversationId: string) {
    const c = await this.prisma.chatConversation.findFirst({ where: { id: conversationId, endpointId } });
    if (!c) throw new NotFoundException('Conversation not found');
    if (c.status !== 'OPEN') throw new ConflictException({ code: 'CHAT_ENDED', message: 'This chat has ended. Start a new one.' });
    return c;
  }

  /** POST /endpoints/:id/chat/conversations/:cid/messages { text } */
  async send(actor: ActorContext, endpointId: string, conversationId: string, body: { text?: unknown }) {
    const ep = await this.visibleEndpoint(actor, endpointId, CAP.CHAT_SEND);
    // A pause set while a chat is open stops the technician writing in it, too.
    await this.containment.assertOpen('remote', ep.customerId);
    const t = chatText(body?.text);
    if (!t.ok) {
      throw new BadRequestException({ code: t.code === 'TOO_LONG' ? 'CHAT_TOO_LONG' : 'CHAT_EMPTY', message: t.code === 'TOO_LONG' ? 'A message can be at most 2,000 characters.' : 'Write something first.' });
    }
    const c = await this.openConversation(endpointId, conversationId);
    await this.assertRate(c, 'TECHNICIAN', MAX_PER_MINUTE.technician);
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true } });
    const name = user ? technicianDisplayName(user) : c.technicianName;
    const m = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.chatMessage.create({
        data: { conversationId, sender: 'TECHNICIAN', authorId: actor.userId, authorName: name, body: t.text },
      });
      // A chat the person started (0.36) names whoever first answers it.
      const named = c.startedBy === 'end_user' && c.technicianName === AWAITING_TECHNICIAN ? { technicianName: name } : {};
      await tx.chatConversation.update({ where: { id: conversationId }, data: { technicianMessages: { increment: 1 }, lastActivityAt: new Date(), ...named } });
      return msg;
    });
    this.wake(endpointId);
    return { message: this.messageView(m) };
  }

  /** POST /endpoints/:id/chat/conversations/:cid/end */
  async end(actor: ActorContext, endpointId: string, conversationId: string) {
    await this.visibleEndpoint(actor, endpointId, CAP.CHAT_SEND);
    const c = await this.prisma.chatConversation.findFirst({ where: { id: conversationId, endpointId }, select: { id: true, status: true } });
    if (!c) throw new NotFoundException('Conversation not found');
    if (c.status !== 'OPEN') return { ended: false, alreadyEnded: true };
    const ok = await this.close(conversationId, 'technician', actor.userId, actor.ip);
    return { ended: ok, alreadyEnded: !ok };
  }

  /**
   * POST /endpoints/:id/chat/conversations/:cid/attachments (0.44), a
   * multipart `file`: the technician sends a file or image. The same gate as
   * a message — support:chat on a computer the caller can see, the `remote`
   * pause, an open chat, the per-minute cap — then the file is classified by
   * its bytes and stored as one message carrying it.
   */
  async sendAttachment(actor: ActorContext, endpointId: string, conversationId: string, file: UploadedChatFile) {
    const ep = await this.visibleEndpoint(actor, endpointId, CAP.CHAT_SEND);
    await this.containment.assertOpen('remote', ep.customerId);
    const a = attachmentOrThrow(checkAttachment(file));
    const c = await this.openConversation(endpointId, conversationId);
    await this.assertRate(c, 'TECHNICIAN', MAX_PER_MINUTE.technician);
    const user = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { firstName: true, lastName: true } });
    const name = user ? technicianDisplayName(user) : c.technicianName;
    const m = await this.storeAttachment(c, { sender: 'TECHNICIAN', authorId: actor.userId, authorName: name, clientId: null, actorIp: actor.ip }, a, file!.buffer!);
    this.wake(endpointId);
    return { message: this.messageView(m) };
  }

  /**
   * GET /endpoints/:id/chat/conversations/:cid/attachments/:aid (0.44): the
   * file, for anyone who may read the transcript — computers:view on a
   * computer they can see. Found only under its own conversation and
   * computer; anything else is the same 404.
   */
  async readAttachment(actor: ActorContext, endpointId: string, conversationId: string, attachmentId: string) {
    await this.visibleEndpoint(actor, endpointId);
    return this.attachmentOf(endpointId, conversationId, attachmentId);
  }

  private async attachmentOf(endpointId: string, conversationId: string, attachmentId: string) {
    if (!isId(conversationId) || !isId(attachmentId)) throw new NotFoundException('Attachment not found');
    const a = await this.prisma.chatAttachment.findFirst({
      where: { id: attachmentId, conversationId, conversation: { endpointId } },
      select: { ...ATTACHMENT_META.select, bytes: true },
    });
    if (!a) throw new NotFoundException('Attachment not found');
    return a;
  }

  /**
   * One attachment, written as a message carrying it. The chat's caps are
   * claimed first by one conditional update (open, under 20 files, room for
   * these bytes), so two uploads at once cannot both take the last place;
   * the message, the file and the audit row follow in the same transaction.
   * The audit row has ids, the kind, the type and the size — never the bytes
   * or the name.
   */
  private async storeAttachment(
    c: ChatConversation,
    who: { sender: 'TECHNICIAN' | 'END_USER'; authorId: string | null; authorName: string; clientId: string | null; actorIp?: string },
    a: Extract<AttachmentCheck, { ok: true }>, bytes: Buffer,
  ): Promise<MessageRow> {
    const tech = who.sender === 'TECHNICIAN';
    // A chat the person started (0.36) names whoever first answers it.
    const named = tech && c.startedBy === 'end_user' && c.technicianName === AWAITING_TECHNICIAN ? { technicianName: who.authorName } : {};
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.chatConversation.updateMany({
        where: {
          id: c.id, status: 'OPEN',
          attachmentCount: { lt: MAX_ATTACHMENTS_PER_CONVERSATION },
          attachmentBytes: { lte: MAX_ATTACHMENT_BYTES_PER_CONVERSATION - a.sizeBytes },
        },
        data: {
          attachmentCount: { increment: 1 }, attachmentBytes: { increment: a.sizeBytes }, lastActivityAt: new Date(),
          ...(tech ? { technicianMessages: { increment: 1 } } : { endUserMessages: { increment: 1 } }), ...named,
        },
      });
      if (claimed.count !== 1) {
        const now = await tx.chatConversation.findUnique({ where: { id: c.id }, select: { status: true, attachmentCount: true } });
        if (!now || now.status !== 'OPEN') throw new ConflictException({ code: 'CHAT_ENDED', message: 'This chat has ended.' });
        refuseAttachment(now.attachmentCount >= MAX_ATTACHMENTS_PER_CONVERSATION ? 'ATTACHMENT_COUNT' : 'ATTACHMENT_TOTAL');
      }
      const msg = await tx.chatMessage.create({
        data: { conversationId: c.id, sender: who.sender, authorId: who.authorId, authorName: who.authorName, body: attachmentBody(a.fileName), clientId: who.clientId },
      });
      const att = await tx.chatAttachment.create({
        data: {
          conversationId: c.id, messageId: msg.id, sender: who.sender, authorId: who.authorId,
          fileName: a.fileName, kind: a.kind, contentType: a.contentType, sizeBytes: a.sizeBytes, sha256: a.sha256, bytes,
        },
        select: ATTACHMENT_META.select,
      });
      await tx.activityLog.create({
        data: this.audit.entry({
          tenantId: c.tenantId ?? undefined, customerId: c.customerId ?? undefined, actorId: who.authorId ?? undefined, actorIp: who.actorIp,
          action: 'CHAT_ATTACHMENT_SENT', resource: 'endpoint', resourceId: c.endpointId,
          meta: { conversationId: c.id, attachmentId: att.id, by: tech ? 'technician' : 'end_user', kind: a.kind, contentType: a.contentType, sizeBytes: a.sizeBytes },
        }),
      });
      return { ...msg, attachment: att };
    });
  }

  /**
   * POST /endpoints/:id/chat/conversations/:cid/ack { ids } (0.36): the
   * technician's panel has shown these replies from the person at the
   * computer. Recorded or not, technicianSeenAt is set once; in a chat that is
   * not recorded the replies are then deleted — both sides have them. Needs
   * support:chat on the computer: a viewer's panel acknowledges nothing, so
   * it cannot make a reply vanish before the chatting technician sees it.
   */
  async ack(actor: ActorContext, endpointId: string, conversationId: string, body: { ids?: unknown }) {
    await this.visibleEndpoint(actor, endpointId, CAP.CHAT_SEND);
    const c = await this.prisma.chatConversation.findFirst({ where: { id: conversationId, endpointId }, select: { id: true, recorded: true } });
    if (!c) throw new NotFoundException('Conversation not found');
    const ids = idList(body?.ids);
    if (!ids.length) return { seen: 0, deleted: 0 };
    const mine = { id: { in: ids }, conversationId: c.id, sender: 'END_USER' as const };
    const seen = await this.prisma.chatMessage.updateMany({ where: { ...mine, technicianSeenAt: null }, data: { technicianSeenAt: new Date() } });
    const deleted = c.recorded ? { count: 0 } : await this.prisma.chatMessage.deleteMany({ where: { ...mine, technicianSeenAt: { not: null }, attachment: { is: null } } });
    return { seen: seen.count, deleted: deleted.count };
  }

  /**
   * Not recorded (0.36): delete the technician messages the person's window
   * has reported read — the last receipt there is. Their row is the only copy.
   * A message carrying an attachment (0.44) stays until the chat ends, when
   * close() deletes it with everything else: the page loads the file from
   * the server, so deleting it once "read" would take it off the screen.
   */
  async purgeRead(conversationId: string) {
    const c = await this.prisma.chatConversation.findUnique({ where: { id: conversationId }, select: { recorded: true } });
    if (!c || c.recorded) return 0;
    const r = await this.prisma.chatMessage.deleteMany({ where: { conversationId, sender: 'TECHNICIAN', readAt: { not: null }, attachment: { is: null } } });
    return r.count;
  }

  /**
   * OPEN → ENDED, at most once whoever asks (technician, agent, sweep): the
   * conditional update decides, and only the caller that made it writes the
   * CHAT_ENDED entry, in the same transaction. Ids and counts only.
   */
  private async close(conversationId: string, reason: 'technician' | 'end_user' | 'inactive', actorId?: string, actorIp?: string): Promise<boolean> {
    const now = new Date();
    const done = await this.prisma.$transaction(async (tx) => {
      const r = await tx.chatConversation.updateMany({
        where: { id: conversationId, status: 'OPEN' },
        data: { status: 'ENDED', endedAt: now, endedById: actorId ?? null, endedReason: reason },
      });
      if (r.count !== 1) return null;
      const c = await tx.chatConversation.findUniqueOrThrow({ where: { id: conversationId } });
      // Not recorded (0.36): nothing of the conversation's text outlives it,
      // and no attachment (0.44): deleting the messages deletes their files.
      if (!c.recorded) await tx.chatMessage.deleteMany({ where: { conversationId } });
      await tx.activityLog.create({
        data: this.audit.entry({
          tenantId: c.tenantId ?? undefined, customerId: c.customerId ?? undefined, actorId, actorIp,
          action: 'CHAT_ENDED', resource: 'endpoint', resourceId: c.endpointId,
          meta: {
            conversationId: c.id, reason, technicianMessages: c.technicianMessages, endUserMessages: c.endUserMessages,
            durationSeconds: Math.round((now.getTime() - c.createdAt.getTime()) / 1000),
          },
        }),
      });
      return c;
    });
    if (done) this.wake(done.endpointId);
    return !!done;
  }

  /** Per conversation per minute, per side; and a ceiling on the whole conversation. */
  private async assertRate(c: ChatConversation, sender: 'TECHNICIAN' | 'END_USER', perMinute: number) {
    if (c.technicianMessages + c.endUserMessages >= MAX_MESSAGES_PER_CONVERSATION) {
      throw new ConflictException({ code: 'CHAT_FULL', message: `A chat holds at most ${MAX_MESSAGES_PER_CONVERSATION} messages. End it and start another.` });
    }
    const recent = await this.prisma.chatMessage.count({ where: { conversationId: c.id, sender, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent >= perMinute) {
      throw new HttpException({ code: 'CHAT_RATE_LIMITED', message: `At most ${perMinute} messages a minute in one chat.` }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  /** Is a chat open on this computer? A flag for the heartbeat; the agent fetches the rest itself. */
  async forHeartbeat(endpointId: string): Promise<{ open: boolean }> {
    const c = await this.prisma.chatConversation.findFirst({ where: { endpointId, status: 'OPEN' }, select: { id: true } });
    return { open: !!c };
  }

  // ── Agent side ────────────────────────────────────────────────────────────

  private wake(endpointId: string) {
    this.waiters.get(endpointId)?.wake();
  }

  /**
   * The agent's chat host, polling. Applies what it reports (window state,
   * delivered / shown / read for this computer's own technician messages),
   * then returns the conversation and any technician messages it has not
   * confirmed — or, when there are none, holds the request for up to 25 s
   * until a technician writes or ends the chat.
   *
   * Bounded: one held poll per computer (a newer one releases the older), at
   * most CHAT_MAX_WAITERS held in the process (beyond that it returns at once
   * with retryAfterMs), and while held the database is read once every 10 s
   * — in case another API process took the write — not continuously.
   */
  async devicePoll(endpointId: string, dto: {
    conversationId?: string; state?: string; detail?: string; userName?: string;
    delivered?: string[]; shown?: string[]; read?: string[]; history?: boolean; noWait?: boolean;
  }) {
    const now = new Date();
    // Receipts: only this computer's own technician messages, and each time
    // only once (the first confirmation is the one recorded).
    const read = idList(dto.read), shown = [...new Set([...idList(dto.shown), ...read])], delivered = [...new Set([...idList(dto.delivered), ...shown])];
    const mine = { sender: 'TECHNICIAN' as const, conversation: { endpointId } };
    if (delivered.length) await this.prisma.chatMessage.updateMany({ where: { id: { in: delivered }, deliveredAt: null, ...mine }, data: { deliveredAt: now } });
    if (shown.length) await this.prisma.chatMessage.updateMany({ where: { id: { in: shown }, shownAt: null, ...mine }, data: { shownAt: now } });
    if (read.length) await this.prisma.chatMessage.updateMany({ where: { id: { in: read }, readAt: null, ...mine }, data: { readAt: now } });
    if (read.length && dto.conversationId && isId(dto.conversationId)) {
      const own = await this.prisma.chatConversation.findFirst({ where: { id: dto.conversationId, endpointId }, select: { id: true } });
      if (own) await this.purgeRead(own.id);
    }

    // The conversation it asks about (to learn it ended), else the open one.
    let conv = dto.conversationId && isId(dto.conversationId)
      ? await this.prisma.chatConversation.findFirst({ where: { id: dto.conversationId, endpointId } })
      : null;
    if (!conv || conv.status !== 'OPEN') {
      const open = await this.prisma.chatConversation.findFirst({ where: { endpointId, status: 'OPEN' } });
      if (open) conv = open;
    }

    if (conv && conv.status === 'OPEN') {
      const st = deviceState(dto.state);
      const user = deviceName(dto.userName);
      await this.prisma.chatConversation.update({
        where: { id: conv.id },
        data: {
          deviceSeenAt: now,
          ...(st && st !== conv.deviceState ? { deviceState: st, deviceStateAt: now } : {}),
          ...(st ? { deviceDetail: deviceName(dto.detail) } : {}),
          ...(user ? { deviceUser: user } : {}),
        },
      });
      if (st === 'user_closed') {
        await this.close(conv.id, 'end_user');
        conv = await this.prisma.chatConversation.findUnique({ where: { id: conv.id } });
      }
    }

    const answer = async () => {
      const c = conv ? await this.prisma.chatConversation.findUnique({ where: { id: conv.id } }) : null;
      if (!c) return { conversation: null, messages: [] as ReturnType<ChatService['deviceMessage']>[] };
      const where: Prisma.ChatMessageWhereInput = dto.history
        ? { conversationId: c.id }
        : { conversationId: c.id, sender: 'TECHNICIAN', deliveredAt: null };
      const rows = c.status === 'OPEN' || dto.history
        ? await this.prisma.chatMessage.findMany({ where, orderBy: [{ createdAt: dto.history ? 'desc' : 'asc' }, { id: 'asc' }], take: dto.history ? 200 : POLL_BATCH, include: { attachment: ATTACHMENT_META } })
        : [];
      if (dto.history) rows.reverse();
      return {
        conversation: { id: c.id, status: c.status, businessName: c.businessName, technicianName: c.technicianName, startedAt: c.createdAt, endedReason: c.endedReason },
        messages: rows.map((m) => this.deviceMessage(m)),
      };
    };

    let out = await answer();
    const idle = out.conversation?.status === 'OPEN' && out.messages.length === 0;
    if (!idle || dto.noWait || dto.history) return { ...out, holdMs: 0 };

    // Nothing to say yet: hold. One waiter per computer.
    if (!this.waiters.has(endpointId) && this.waiters.size >= this.cfg.maxWaiters) {
      return { ...out, holdMs: 0, retryAfterMs: 5000 };
    }
    this.waiters.get(endpointId)?.wake();
    const started = Date.now();
    await new Promise<void>((resolve) => {
      let done = false;
      let recheck: ReturnType<typeof setInterval> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (recheck) clearInterval(recheck);
        if (this.waiters.get(endpointId) === me) this.waiters.delete(endpointId);
        resolve();
      };
      const me: Waiter = { wake: finish };
      const timer = setTimeout(finish, POLL_HOLD_MS);
      // Another API process may have taken the technician's write.
      recheck = setInterval(() => {
        void this.prisma.chatMessage.count({ where: { conversationId: conv!.id, sender: 'TECHNICIAN', deliveredAt: null } })
          .then(async (n) => {
            const s = await this.prisma.chatConversation.findUnique({ where: { id: conv!.id }, select: { status: true } });
            if (n > 0 || s?.status !== 'OPEN') finish();
          })
          .catch(() => { /* the hold just runs out */ });
      }, POLL_RECHECK_MS);
      this.waiters.set(endpointId, me);
    });
    out = await answer();
    return { ...out, holdMs: Date.now() - started };
  }

  /**
   * A message as the 0.34 Win32 chat window gets it. That window draws text
   * only, so an attachment (0.44) is a line saying what was sent and where to
   * see it; it is never handed the file.
   */
  private deviceMessage(m: MessageRow) {
    const text = m.attachment ? `Sent a file: ${m.attachment.fileName}. This chat window cannot show files: open the chat from the tray icon once the agent is updated.` : m.body;
    return { id: m.id, from: m.sender === 'TECHNICIAN' ? 'technician' : 'user', name: m.authorName, text, at: m.createdAt };
  }

  /** What the person at the computer typed. Same length rule as the technician; capped per conversation and per computer. */
  async deviceReply(endpointId: string, dto: { conversationId: string; clientId: string; text: string }) {
    if (!isId(dto.conversationId)) throw new NotFoundException('Conversation not found');
    const t = chatText(dto.text);
    if (!t.ok) throw new BadRequestException({ code: t.code === 'TOO_LONG' ? 'CHAT_TOO_LONG' : 'CHAT_EMPTY', message: 'A message must be 1 to 2,000 characters.' });
    const c = await this.prisma.chatConversation.findFirst({ where: { id: dto.conversationId, endpointId } });
    if (!c) throw new NotFoundException('Conversation not found');
    // A retry of a reply already stored: the same answer, nothing new written.
    const dup = await this.prisma.chatMessage.findUnique({ where: { conversationId_clientId: { conversationId: c.id, clientId: dto.clientId } } });
    if (dup) return { id: dup.id, at: dup.createdAt, duplicate: true };
    if (c.status !== 'OPEN') throw new ConflictException({ code: 'CHAT_ENDED', message: 'This chat has ended.' });
    await this.assertRate(c, 'END_USER', MAX_PER_MINUTE.endUser);
    const deviceRecent = await this.prisma.chatMessage.count({
      where: { sender: 'END_USER', createdAt: { gt: new Date(Date.now() - 60_000) }, conversation: { endpointId } },
    });
    if (deviceRecent >= MAX_DEVICE_PER_MINUTE) {
      throw new HttpException({ code: 'CHAT_RATE_LIMITED', message: `At most ${MAX_DEVICE_PER_MINUTE} messages a minute from one computer.` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      const m = await this.prisma.$transaction(async (tx) => {
        const msg = await tx.chatMessage.create({
          data: { conversationId: c.id, sender: 'END_USER', authorName: c.deviceUser ?? 'Person at the computer', body: t.text, clientId: dto.clientId },
        });
        await tx.chatConversation.update({ where: { id: c.id }, data: { endUserMessages: { increment: 1 }, lastActivityAt: new Date() } });
        return msg;
      });
      return { id: m.id, at: m.createdAt, duplicate: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await this.prisma.chatMessage.findUnique({ where: { conversationId_clientId: { conversationId: c.id, clientId: dto.clientId } } });
        if (again) return { id: again.id, at: again.createdAt, duplicate: true };
      }
      throw e;
    }
  }

  // ── The tray and the /assist page (0.36) ─────────────────────────────────
  //
  // Called by TrayService (the tray's routes, authenticated by the device
  // secret or the tray key) and AssistService (the page, authenticated by
  // its /assist cookie). Neither caller is a portal user: every method takes
  // the endpoint id its credential proved, and touches only that computer's
  // conversations.

  /** The open conversation, what the tray needs for its badge, and the receipts it brings. */
  async forTray(endpointId: string, delivered: unknown) {
    const ids = idList(delivered);
    if (ids.length) {
      await this.prisma.chatMessage.updateMany({ where: { id: { in: ids }, deliveredAt: null, sender: 'TECHNICIAN', conversation: { endpointId } }, data: { deliveredAt: new Date() } });
    }
    const c = await this.prisma.chatConversation.findFirst({ where: { endpointId, status: 'OPEN' }, select: { ...CONV_SUMMARY } });
    if (!c) return null;
    const unread = await this.prisma.chatMessage.findMany({
      where: { conversationId: c.id, sender: 'TECHNICIAN', shownAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' }, take: POLL_BATCH,
    });
    return { conversation: c, unread: unread.map((u) => u.id) };
  }

  /**
   * Bind the open conversation to the person at the computer, or refuse: a
   * chat is with one Windows account. The first account to open it claims
   * it; another account on the same computer is told so (409), and never
   * sees the transcript.
   */
  async bindForUser(endpointId: string, localUser: string | null) {
    const c = await this.prisma.chatConversation.findFirst({ where: { endpointId, status: 'OPEN' } });
    if (!c) return null;
    if (c.deviceUser && localUser && c.deviceUser !== localUser) {
      throw new ConflictException({ code: 'CHAT_OTHER_USER', message: 'This chat is with someone else signed in on this computer.' });
    }
    if (!c.deviceUser && localUser) {
      await this.prisma.chatConversation.updateMany({ where: { id: c.id, deviceUser: null }, data: { deviceUser: localUser } });
    }
    await this.prisma.chatConversation.update({ where: { id: c.id }, data: { deviceSeenAt: new Date(), ...(c.deviceState ? {} : { deviceState: 'connecting', deviceStateAt: new Date() }) } });
    return c.id;
  }

  /**
   * The person at the computer starts a chat from the tray (0.36). It needs
   * a business (the window names it), and is refused while a `remote` pause
   * covers it. The conversation is recorded or not as a technician's would
   * be. Returns the new conversation — or the open one, if a technician
   * started one meanwhile.
   */
  async endUserStart(ep: { id: string; tenantId: string | null; customerId: string | null; customerName: string | null; customerRecording: boolean | null },
    localUser: string | null, supportRequestId: string | null) {
    if (!ep.customerId) throw new ConflictException({ code: 'CHAT_UNSUPPORTED', reason: 'no_business', message: 'This computer is not assigned to a business yet.' });
    await this.containment.assertOpen('remote', ep.customerId);
    const existing = await this.prisma.chatConversation.findFirst({ where: { endpointId: ep.id, status: 'OPEN' }, select: { id: true } });
    if (existing) return { id: existing.id, existing: true };
    const recorded = await this.recordingFor(ep.customerRecording);
    try {
      const c = await this.prisma.$transaction(async (tx) => {
        const conv = await tx.chatConversation.create({
          data: {
            tenantId: ep.tenantId, customerId: ep.customerId, endpointId: ep.id, supportRequestId, startedById: null, startedBy: 'end_user',
            technicianName: AWAITING_TECHNICIAN, businessName: deviceName(ep.customerName ?? '') ?? 'Your IT provider', recorded,
            deviceUser: localUser, deviceState: 'window_open', deviceStateAt: new Date(), deviceSeenAt: new Date(),
          },
          select: { id: true },
        });
        await tx.activityLog.create({
          data: this.audit.entry({
            tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined,
            action: 'CHAT_STARTED', resource: 'endpoint', resourceId: ep.id,
            meta: { conversationId: conv.id, recorded, by: 'end_user', ...(supportRequestId ? { supportRequestId } : {}) },
          }),
        });
        return conv;
      });
      this.wake(ep.id);
      return { id: c.id, existing: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const c = await this.prisma.chatConversation.findFirst({ where: { endpointId: ep.id, status: 'OPEN' }, select: { id: true } });
        if (c) return { id: c.id, existing: true };
      }
      throw e;
    }
  }

  /** What the /assist page shows: the conversation, and its messages oldest first (newest 200). */
  async assistView(endpointId: string, conversationId: string) {
    const c = await this.prisma.chatConversation.findFirst({ where: { id: conversationId, endpointId } });
    if (!c) return null;
    if (c.status === 'OPEN') {
      await this.prisma.chatConversation.update({
        where: { id: c.id },
        data: { deviceSeenAt: new Date(), ...(c.deviceState !== 'window_open' ? { deviceState: 'window_open', deviceStateAt: new Date() } : {}) },
      });
    }
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId: c.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200, include: { attachment: ATTACHMENT_META },
    });
    rows.reverse();
    return {
      conversation: {
        id: c.id, status: c.status, recorded: c.recorded, startedBy: c.startedBy, businessName: c.businessName,
        technicianName: c.technicianName, endedReason: c.endedReason, startedAt: c.createdAt,
      },
      messages: rows.map((m) => ({
        id: m.id, from: m.sender === 'TECHNICIAN' ? 'technician' : 'user', name: m.authorName, text: m.body, at: m.createdAt,
        clientId: m.clientId, receivedBySupport: m.sender === 'END_USER' ? !!m.technicianSeenAt : undefined,
        attachment: m.attachment ? attachmentView(m.attachment) : null,
      })),
    };
  }

  /** The page drew these technician messages (shown), while it was in front (read). Then, if not recorded, purge. */
  async assistReceipts(endpointId: string, conversationId: string, body: { shown?: unknown; read?: unknown }) {
    const now = new Date();
    const read = idList(body?.read), shown = [...new Set([...idList(body?.shown), ...read])];
    const mine = { sender: 'TECHNICIAN' as const, conversationId, conversation: { endpointId } };
    if (shown.length) {
      await this.prisma.chatMessage.updateMany({ where: { id: { in: shown }, deliveredAt: null, ...mine }, data: { deliveredAt: now } });
      await this.prisma.chatMessage.updateMany({ where: { id: { in: shown }, shownAt: null, ...mine }, data: { shownAt: now } });
    }
    if (read.length) await this.prisma.chatMessage.updateMany({ where: { id: { in: read }, readAt: null, ...mine }, data: { readAt: now } });
    const purged = read.length ? await this.purgeRead(conversationId) : 0;
    return { shown: shown.length, read: read.length, purged };
  }

  /**
   * The person at the computer sends a file from the /assist page (0.44).
   * The page's gate — its cookie, bound to this conversation — is checked by
   * the caller; here, the same rules as a reply (an open chat, per-minute
   * caps per conversation and per computer, a client id for retries) and,
   * unlike a text reply, the `remote` pause: a computer under suspicion does
   * not get to upload files.
   */
  async assistSendAttachment(endpointId: string, customerId: string | null, conversationId: string, clientId: string, file: UploadedChatFile) {
    await this.containment.assertOpen('remote', customerId);
    const a = attachmentOrThrow(checkAttachment(file));
    const c = await this.prisma.chatConversation.findFirst({ where: { id: conversationId, endpointId } });
    if (!c) throw new NotFoundException('Conversation not found');
    const prior = () => this.prisma.chatMessage.findUnique({
      where: { conversationId_clientId: { conversationId: c.id, clientId } }, include: { attachment: ATTACHMENT_META },
    });
    const dup = await prior();
    if (dup) return { id: dup.id, at: dup.createdAt, duplicate: true, attachment: dup.attachment ? attachmentView(dup.attachment) : null };
    if (c.status !== 'OPEN') throw new ConflictException({ code: 'CHAT_ENDED', message: 'This chat has ended.' });
    await this.assertRate(c, 'END_USER', MAX_PER_MINUTE.endUser);
    const deviceRecent = await this.prisma.chatMessage.count({
      where: { sender: 'END_USER', createdAt: { gt: new Date(Date.now() - 60_000) }, conversation: { endpointId } },
    });
    if (deviceRecent >= MAX_DEVICE_PER_MINUTE) {
      throw new HttpException({ code: 'CHAT_RATE_LIMITED', message: `At most ${MAX_DEVICE_PER_MINUTE} messages a minute from one computer.` }, HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      const m = await this.storeAttachment(c, { sender: 'END_USER', authorId: null, authorName: c.deviceUser ?? 'Person at the computer', clientId }, a, file!.buffer!);
      return { id: m.id, at: m.createdAt, duplicate: false, attachment: m.attachment ? attachmentView(m.attachment) : null };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const again = await prior();
        if (again) return { id: again.id, at: again.createdAt, duplicate: true, attachment: again.attachment ? attachmentView(again.attachment) : null };
      }
      throw e;
    }
  }

  /** The page reads a file in its own conversation, and only there. */
  async assistAttachment(endpointId: string, conversationId: string, attachmentId: string) {
    return this.attachmentOf(endpointId, conversationId, attachmentId);
  }

  /** The person ended the chat from the page. */
  async assistEnd(endpointId: string, conversationId: string) {
    const c = await this.prisma.chatConversation.findFirst({ where: { id: conversationId, endpointId }, select: { id: true, status: true } });
    if (!c) throw new NotFoundException('Conversation not found');
    if (c.status !== 'OPEN') return { ended: false };
    return { ended: await this.close(conversationId, 'end_user') };
  }

  // ── Sweep ─────────────────────────────────────────────────────────────────

  /** One pass: end quiet conversations, then delete transcripts past retention. Bounded and idempotent. */
  async sweep(now = new Date()) {
    if (this.busy) return null;
    this.busy = true;
    try {
      const expired = await this.expireInactive(now);
      const pruned = await this.prune(now);
      if (expired || pruned.conversations) this.logger.log(`ended ${expired} inactive chat(s); pruned ${pruned.conversations} conversation(s), ${pruned.messages} message(s)`);
      return { expired, pruned };
    } catch (e) {
      this.logger.warn(`sweep failed: ${String(e)}`);
      return null;
    } finally {
      this.busy = false;
    }
  }

  private async expireInactive(now: Date): Promise<number> {
    const quiet = await this.prisma.chatConversation.findMany({
      where: { status: 'OPEN', lastActivityAt: { lt: new Date(now.getTime() - INACTIVE_MS) } },
      select: { id: true }, take: 200,
    });
    let n = 0;
    for (const q of quiet) if (await this.close(q.id, 'inactive')) n++;
    return n;
  }

  /**
   * Conversations that ended before the cutoff, deleted with their messages
   * (cascade), at most batch × batches per pass. Open conversations are never
   * touched, whatever their age. Each pass that deleted something writes one
   * CHAT_PRUNED entry with the counts — a new row; nothing in the audit log
   * is changed, and the CHAT_STARTED / CHAT_ENDED rows stay.
   */
  async prune(now = new Date()) {
    const cutoff = retentionCutoff(now.getTime(), this.cfg.retentionDays);
    let conversations = 0, messages = 0, attachments = 0;
    for (let i = 0; i < this.cfg.batches; i++) {
      const rows = await this.prisma.chatConversation.findMany({
        where: { status: 'ENDED', endedAt: { lt: cutoff } }, select: { id: true, technicianMessages: true, endUserMessages: true, attachmentCount: true },
        orderBy: { endedAt: 'asc' }, take: this.cfg.batch,
      });
      if (!rows.length) break;
      const r = await this.prisma.chatConversation.deleteMany({ where: { id: { in: rows.map((x) => x.id) }, status: 'ENDED', endedAt: { lt: cutoff } } });
      conversations += r.count;
      messages += rows.reduce((s, x) => s + x.technicianMessages + x.endUserMessages, 0);
      // Their attachments go with them (foreign keys, ON DELETE CASCADE).
      attachments += rows.reduce((s, x) => s + x.attachmentCount, 0);
      if (rows.length < this.cfg.batch) break;
    }
    if (conversations) {
      await this.audit.log({
        action: 'CHAT_PRUNED', resource: 'chat',
        meta: { conversations, messages, attachments, retentionDays: this.cfg.retentionDays, endedBefore: cutoff.toISOString() },
      });
    }
    return { conversations, messages, attachments, cutoff };
  }
}
