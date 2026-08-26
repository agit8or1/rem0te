import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NoteVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';

interface CreateNoteDto {
  content: string;
  endpointId?: string;
  businessId?: string;
  customerId?: string;
  sessionId?: string;
  visibility?: NoteVisibility;
  isPinned?: boolean;
}

interface UpdateNoteDto {
  content?: string;
  isPinned?: boolean;
}

/**
 * Notes hang off a computer, a business or a session. Rather than filter
 * notes directly, every method resolves the *parent* through the business
 * scope first — if the caller cannot see the computer, they cannot see the
 * notes attached to it.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly acl: AccessControlService,
  ) {}

  private noteInclude = {
    author: { select: { id: true, email: true, firstName: true, lastName: true } },
    comments: {
      include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
      orderBy: { createdAt: 'asc' as const },
    },
  };

  async findByEndpoint(actor: ActorContext, endpointId: string, page = 1, limit = 20) {
    await this.acl.assertEndpointInScope(actor, endpointId);
    const skip = (page - 1) * limit;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.note.findMany({
        where: { endpointId },
        include: this.noteInclude,
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.note.count({ where: { endpointId } }),
    ]);
    return { data, total, page, limit };
  }

  async findByBusiness(actor: ActorContext, businessId: string, page = 1, limit = 20) {
    await this.acl.assertBusinessInScope(actor, businessId);
    const skip = (page - 1) * limit;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.note.findMany({
        where: { customerId: businessId },
        include: this.noteInclude,
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.note.count({ where: { customerId: businessId } }),
    ]);
    return { data, total, page, limit };
  }

  async findBySession(actor: ActorContext, sessionId: string) {
    await this.assertSessionInScope(actor, sessionId);
    return this.prisma.note.findMany({
      where: { sessionId },
      include: this.noteInclude,
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(actor: ActorContext, dto: CreateNoteDto) {
    const businessId = dto.businessId ?? dto.customerId;

    // Whatever the note is attached to has to be inside the caller's business
    // — otherwise a note is a way to write into someone else's records.
    // Declared without initialisers on purpose: every branch below either
    // assigns both or throws, so a default would only mask a missed case.
    let tenantId: string | null;
    let noteBusinessId: string | null;

    if (dto.endpointId) {
      const endpoint = await this.acl.assertEndpointInScope(actor, dto.endpointId);
      tenantId = endpoint.tenantId;
      noteBusinessId = endpoint.customerId;
    } else if (businessId) {
      const business = await this.acl.assertBusinessInScope(actor, businessId);
      tenantId = business.tenantId;
      noteBusinessId = business.id;
    } else if (dto.sessionId) {
      const session = await this.assertSessionInScope(actor, dto.sessionId);
      tenantId = session.tenantId;
      noteBusinessId = session.customerId;
    } else {
      throw new BadRequestException('A note must be attached to a computer, a business or a session');
    }

    if (!tenantId) throw new BadRequestException('No platform context');

    const note = await this.prisma.note.create({
      data: {
        tenantId,
        authorId: actor.userId,
        content: dto.content,
        endpointId: dto.endpointId ?? null,
        customerId: noteBusinessId,
        sessionId: dto.sessionId ?? null,
        visibility: dto.visibility ?? NoteVisibility.INTERNAL,
        isPinned: dto.isPinned ?? false,
      },
      include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    await this.audit.log({
      tenantId, customerId: noteBusinessId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'NOTE_CREATED', resource: 'note', resourceId: note.id,
      meta: { endpointId: dto.endpointId, businessId: noteBusinessId, sessionId: dto.sessionId },
    });

    return note;
  }

  async update(actor: ActorContext, id: string, dto: UpdateNoteDto) {
    const note = await this.assertNoteInScope(actor, id);
    if (!this.acl.isBusinessOwner(actor) && note.authorId !== actor.userId) {
      throw new ForbiddenException('You can only edit your own notes');
    }

    const updated = await this.prisma.note.update({
      where: { id },
      data: {
        ...(dto.content !== undefined ? { content: dto.content } : {}),
        ...(dto.isPinned !== undefined ? { isPinned: dto.isPinned } : {}),
      },
      include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    await this.audit.log({
      tenantId: note.tenantId, customerId: note.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'NOTE_UPDATED', resource: 'note', resourceId: id,
      meta: dto as Record<string, unknown>,
    });
    return updated;
  }

  async delete(actor: ActorContext, id: string) {
    const note = await this.assertNoteInScope(actor, id);
    if (!this.acl.isBusinessOwner(actor) && note.authorId !== actor.userId) {
      throw new ForbiddenException('You can only delete your own notes');
    }

    await this.prisma.note.delete({ where: { id } });
    await this.audit.log({
      tenantId: note.tenantId, customerId: note.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'NOTE_DELETED', resource: 'note', resourceId: id, meta: {},
    });
    return { success: true };
  }

  async addComment(actor: ActorContext, noteId: string, content: string) {
    const note = await this.assertNoteInScope(actor, noteId);

    const comment = await this.prisma.noteComment.create({
      data: { noteId, authorId: actor.userId, content },
      include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    await this.audit.log({
      tenantId: note.tenantId, customerId: note.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'NOTE_COMMENT_ADDED', resource: 'note', resourceId: noteId,
      meta: { commentId: comment.id },
    });
    return comment;
  }

  // ── Scope helpers ─────────────────────────────────────────────────────────

  private async assertNoteInScope(actor: ActorContext, id: string) {
    const note = await this.prisma.note.findUnique({
      where: { id },
      select: { id: true, tenantId: true, customerId: true, endpointId: true, authorId: true },
    });
    if (!note) throw new NotFoundException('Note not found');

    if (!actor.isPlatformAdmin) {
      if (note.endpointId) {
        await this.acl.assertEndpointInScope(actor, note.endpointId);
      } else if (!note.customerId || note.customerId !== actor.businessId) {
        throw new NotFoundException('Note not found');
      }
    }
    return note;
  }

  private async assertSessionInScope(actor: ActorContext, sessionId: string) {
    const session = await this.prisma.supportSession.findUnique({
      where: { id: sessionId },
      select: { id: true, tenantId: true, customerId: true },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (!actor.isPlatformAdmin && session.customerId !== actor.businessId) {
      throw new NotFoundException('Session not found');
    }
    return session;
  }
}
