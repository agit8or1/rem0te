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

const CONV_SUMMARY = {
  id: true, status: true, startedById: true, technicianName: true, businessName: true, supportRequestId: true,
  deviceState: true, deviceDetail: true, deviceUser: true, deviceStateAt: true, deviceSeenAt: true, lastActivityAt: true,
  endedAt: true, endedById: true, endedReason: true, technicianMessages: true, endUserMessages: true, createdAt: true,
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
        customer: { select: { name: true } },
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
    return chatSupport({ ...ep, agentBound: !!ep.rustdeskNode?.agentSecretHash });
  }

  /** May this actor write in chats on this computer? The same test assertEndpointInScope makes, without throwing. */
  private maySend(actor: ActorContext, endpointId: string): boolean {
    if (!this.acl.can(actor, CAP.CHAT_SEND)) return false;
    if (actor.technician) return technicianGrantAllows(actor.technician, CAP.CHAT_SEND, endpointId);
    return true;
  }

  private conversationView(c: Pick<ChatConversation, keyof typeof CONV_SUMMARY>, now = Date.now()) {
    return { ...c, presence: presence(c, now) };
  }

  private messageView(m: ChatMessage) {
    return {
      id: m.id, sender: m.sender, authorName: m.authorName, body: m.body, createdAt: m.createdAt,
      deliveredAt: m.deliveredAt, shownAt: m.shownAt, readAt: m.readAt, receipt: receipt(m),
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
    return {
      support: this.support(ep),
      canSend: this.maySend(actor, endpointId),
      contained: pause ? { pauseId: pause.id, message: pauseMessage(pause, 'remote') } : null,
      // What the last heartbeat said about who is signed in — a hint only; the
      // chat window's own report (presence) is what counts.
      lastSignedInUser: ep.inventory?.liveSampledAt ? { name: ep.inventory.loggedOnUser || null, at: ep.inventory.liveSampledAt } : null,
      open: open ? this.conversationView(open, now) : null,
      conversations: rows.map((r) => this.conversationView(r, now)),
      limits: { maxChars: MAX_MESSAGE_CHARS, perMinute: MAX_PER_MINUTE.technician, retentionDays: this.cfg.retentionDays },
    };
  }

  /** GET /endpoints/:id/chat/conversations/:cid[?after=messageId]: the transcript, oldest first. */
  async transcript(actor: ActorContext, endpointId: string, conversationId: string, after?: string) {
    await this.visibleEndpoint(actor, endpointId);
    const c = await this.prisma.chatConversation.findFirst({ where: { id: conversationId, endpointId }, select: CONV_SUMMARY });
    if (!c) throw new NotFoundException('Conversation not found');
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
    });
    rows.reverse();
    return { conversation: this.conversationView(c), messages: rows.map((m) => this.messageView(m)), truncated: rows.length === TRANSCRIPT_PAGE };
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
    try {
      const conv = await this.prisma.$transaction(async (tx) => {
        const c = await tx.chatConversation.create({
          data: { tenantId: ep.tenantId, customerId: ep.customerId, endpointId, supportRequestId, startedById: actor.userId, technicianName, businessName },
          select: CONV_SUMMARY,
        });
        await tx.activityLog.create({
          data: this.audit.entry({
            tenantId: ep.tenantId ?? undefined, customerId: ep.customerId ?? undefined, actorId: actor.userId, actorIp: actor.ip,
            action: 'CHAT_STARTED', resource: 'endpoint', resourceId: endpointId,
            meta: { conversationId: c.id, ...(supportRequestId ? { supportRequestId } : {}) },
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
    const m = await this.prisma.$transaction(async (tx) => {
      const msg = await tx.chatMessage.create({
        data: { conversationId, sender: 'TECHNICIAN', authorId: actor.userId, authorName: user ? technicianDisplayName(user) : c.technicianName, body: t.text },
      });
      await tx.chatConversation.update({ where: { id: conversationId }, data: { technicianMessages: { increment: 1 }, lastActivityAt: new Date() } });
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
        ? await this.prisma.chatMessage.findMany({ where, orderBy: [{ createdAt: dto.history ? 'desc' : 'asc' }, { id: 'asc' }], take: dto.history ? 200 : POLL_BATCH })
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

  private deviceMessage(m: ChatMessage) {
    return { id: m.id, from: m.sender === 'TECHNICIAN' ? 'technician' : 'user', name: m.authorName, text: m.body, at: m.createdAt };
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
    let conversations = 0, messages = 0;
    for (let i = 0; i < this.cfg.batches; i++) {
      const rows = await this.prisma.chatConversation.findMany({
        where: { status: 'ENDED', endedAt: { lt: cutoff } }, select: { id: true, technicianMessages: true, endUserMessages: true },
        orderBy: { endedAt: 'asc' }, take: this.cfg.batch,
      });
      if (!rows.length) break;
      const r = await this.prisma.chatConversation.deleteMany({ where: { id: { in: rows.map((x) => x.id) }, status: 'ENDED', endedAt: { lt: cutoff } } });
      conversations += r.count;
      messages += rows.reduce((s, x) => s + x.technicianMessages + x.endUserMessages, 0);
      if (rows.length < this.cfg.batch) break;
    }
    if (conversations) {
      await this.audit.log({
        action: 'CHAT_PRUNED', resource: 'chat',
        meta: { conversations, messages, retentionDays: this.cfg.retentionDays, endedBefore: cutoff.toISOString() },
      });
    }
    return { conversations, messages, cutoff };
  }
}
