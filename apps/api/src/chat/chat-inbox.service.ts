import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { isId } from './chat-policy';

/** Open chats the inbox lists, newest activity first. */
export const INBOX_LIMIT = 50;
/** A preview is this many characters of the newest reply, on one line. */
export const PREVIEW_CHARS = 100;

export type InboxChat = {
  conversationId: string; endpointId: string; computerName: string; businessName: string | null;
  startedBy: string; lastActivityAt: Date; unread: number;
  latest: { id: string; at: Date; preview: string; attachment: 'image' | 'file' | null; authorName: string } | null;
};

/**
 * The console's chat inbox (0.44): wherever a technician is in the app, the
 * open chats on computers they can see, how many replies from the person at
 * the computer they have not read, and a short preview of the newest.
 *
 *   GET  /chat/inbox[?since=version]   computers:view
 *   POST /chat/inbox/read              computers:view, the computer visible
 *
 * Polled every ~10 s by every signed-in console, so it is two small queries:
 * the visible open conversations (endpointVisibilityWhere — the device list's
 * own rule — AND not archived, at most 50), and one grouped read of their
 * unread replies against this user's read marks. When nothing has moved
 * since the version the caller holds, the second query is not run at all.
 *
 * Read marks are per user (ChatReadState): reading a chat clears it for you,
 * not for a colleague. A preview is what the caller could read in the
 * transcript anyway (same capability, same visibility).
 */
@Injectable()
export class ChatInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
  ) {}

  async inbox(actor: ActorContext, since?: string) {
    const convs = await this.prisma.chatConversation.findMany({
      where: { status: 'OPEN', endpoint: { AND: [this.acl.endpointVisibilityWhere(actor), { status: { not: 'ARCHIVED' } }] } },
      orderBy: { lastActivityAt: 'desc' }, take: INBOX_LIMIT,
      select: {
        id: true, endpointId: true, startedBy: true, lastActivityAt: true,
        endpoint: { select: { name: true, hostname: true, customer: { select: { name: true } } } },
        readStates: { where: { userId: actor.userId }, select: { lastReadAt: true } },
      },
    });
    const version = createHash('sha256')
      .update(convs.map((c) => `${c.id}:${c.lastActivityAt.getTime()}:${c.readStates[0]?.lastReadAt.getTime() ?? 0}`).join('|'))
      .digest('base64url').slice(0, 22);
    if (since && since === version) return { version, unchanged: true as const };
    if (!convs.length) return { version, unchanged: false as const, chats: [] as InboxChat[], totalUnread: 0 };

    const ids = convs.map((c) => c.id);
    // One grouped read: per conversation, the replies after this user's mark,
    // and the newest reply (preview cut in SQL; the bytes of an attachment
    // are never touched — only whether one exists).
    const rows = await this.prisma.$queryRaw<{ conversationId: string; unread: number; id: string | null; at: Date | null; preview: string | null; authorName: string | null; kind: string | null }[]>(Prisma.sql`
      SELECT c.id AS "conversationId",
        (SELECT count(*)::int FROM "ChatMessage" m
          WHERE m."conversationId" = c.id AND m."sender" = 'END_USER'
            AND m."createdAt" > COALESCE(r."lastReadAt", 'epoch'::timestamp)) AS unread,
        l.id, l."createdAt" AS at, left(l."body", ${PREVIEW_CHARS}::int) AS preview, l."authorName", a."kind"
      FROM "ChatConversation" c
      LEFT JOIN "ChatReadState" r ON r."conversationId" = c.id AND r."userId" = ${actor.userId}
      LEFT JOIN LATERAL (
        SELECT m.id, m."createdAt", m."body", m."authorName" FROM "ChatMessage" m
        WHERE m."conversationId" = c.id AND m."sender" = 'END_USER'
        ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1
      ) l ON true
      LEFT JOIN "ChatAttachment" a ON a."messageId" = l.id
      WHERE c.id = ANY(${ids}::text[])`);
    const by = new Map(rows.map((r) => [r.conversationId, r]));
    const chats: InboxChat[] = convs.map((c) => {
      const r = by.get(c.id);
      return {
        conversationId: c.id, endpointId: c.endpointId, computerName: c.endpoint.name || c.endpoint.hostname || 'Computer',
        businessName: c.endpoint.customer?.name ?? null, startedBy: c.startedBy, lastActivityAt: c.lastActivityAt,
        unread: r?.unread ?? 0,
        latest: r?.id && r.at ? {
          id: r.id, at: r.at, preview: (r.preview ?? '').replace(/\s+/g, ' ').trim(), authorName: r.authorName ?? '',
          attachment: r.kind === 'image' ? 'image' : r.kind === 'file' ? 'file' : null,
        } : null,
      };
    });
    return { version, unchanged: false as const, chats, totalUnread: chats.reduce((s, c) => s + c.unread, 0) };
  }

  /**
   * Mark a chat read up to `upTo` (the newest message the caller's panel
   * showed; never later than now), for this user only. The computer must be
   * one the caller can see — the same check the transcript makes. The mark
   * only moves forward.
   */
  async markRead(actor: ActorContext, conversationId: unknown, upTo?: unknown) {
    if (!isId(conversationId)) throw new NotFoundException('Conversation not found');
    const c = await this.prisma.chatConversation.findUnique({ where: { id: conversationId }, select: { id: true, endpointId: true } });
    if (!c) throw new NotFoundException('Conversation not found');
    await this.acl.assertEndpointInScope(actor, c.endpointId, 'computers:view');
    const visible = await this.prisma.endpoint.count({ where: { AND: [this.acl.endpointVisibilityWhere(actor), { id: c.endpointId }] } });
    if (!visible) throw new NotFoundException('Conversation not found');
    const now = Date.now();
    const asked = typeof upTo === 'string' ? Date.parse(upTo) : NaN;
    const at = new Date(Number.isFinite(asked) ? Math.min(asked, now) : now);
    await this.prisma.chatReadState.upsert({
      where: { userId_conversationId: { userId: actor.userId, conversationId: c.id } },
      create: { userId: actor.userId, conversationId: c.id, lastReadAt: at },
      update: {},
    });
    await this.prisma.chatReadState.updateMany({ where: { userId: actor.userId, conversationId: c.id, lastReadAt: { lt: at } }, data: { lastReadAt: at } });
    return { conversationId: c.id, lastReadAt: at };
  }
}
