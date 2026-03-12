import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { NoteVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

interface CreateNoteDto {
  content: string;
  endpointId?: string;
  customerId?: string;
  sessionId?: string;
  visibility?: NoteVisibility;
  isPinned?: boolean;
}

interface UpdateNoteDto {
  content?: string;
  isPinned?: boolean;
}

@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findByEndpoint(tenantId: string, endpointId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.note.findMany({
        where: { tenantId, endpointId },
        include: {
          author: { select: { id: true, email: true, firstName: true, lastName: true } },
          comments: {
            include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.note.count({ where: { tenantId, endpointId } }),
    ]);
    return { data, total, page, limit };
  }

  async findByCustomer(tenantId: string, customerId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await this.prisma.$transaction([
      this.prisma.note.findMany({
        where: { tenantId, customerId },
        include: {
          author: { select: { id: true, email: true, firstName: true, lastName: true } },
          comments: {
            include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.note.count({ where: { tenantId, customerId } }),
    ]);
    return { data, total, page, limit };
  }

  async findBySession(tenantId: string, sessionId: string) {
    return this.prisma.note.findMany({
      where: { tenantId, sessionId },
      include: {
        author: { select: { id: true, email: true, firstName: true, lastName: true } },
        comments: {
          include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async create(tenantId: string, authorId: string, dto: CreateNoteDto) {
    const note = await this.prisma.note.create({
      data: {
        tenantId,
        authorId,
        content: dto.content,
        endpointId: dto.endpointId ?? null,
        customerId: dto.customerId ?? null,
        sessionId: dto.sessionId ?? null,
        visibility: dto.visibility ?? NoteVisibility.INTERNAL,
        isPinned: dto.isPinned ?? false,
      },
      include: {
        author: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });

    await this.audit.log({
      tenantId,
      actorId: authorId,
      action: 'NOTE_CREATED',
      resource: 'note',
      resourceId: note.id,
      meta: { endpointId: dto.endpointId, customerId: dto.customerId, sessionId: dto.sessionId },
    });

    return note;
  }

  async update(tenantId: string, id: string, authorId: string, dto: UpdateNoteDto, isAdmin = false) {
    const note = await this.prisma.note.findFirst({ where: { id, tenantId } });
    if (!note) throw new NotFoundException(`Note ${id} not found`);
    if (!isAdmin && note.authorId !== authorId) {
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

    await this.audit.log({ tenantId, actorId: authorId, action: 'NOTE_UPDATED', resource: 'note', resourceId: id, meta: dto as Record<string, unknown> });
    return updated;
  }

  async delete(tenantId: string, id: string, authorId: string, isAdmin = false) {
    const note = await this.prisma.note.findFirst({ where: { id, tenantId } });
    if (!note) throw new NotFoundException(`Note ${id} not found`);
    if (!isAdmin && note.authorId !== authorId) {
      throw new ForbiddenException('You can only delete your own notes');
    }

    await this.prisma.note.delete({ where: { id } });
    await this.audit.log({ tenantId, actorId: authorId, action: 'NOTE_DELETED', resource: 'note', resourceId: id, meta: {} });
    return { success: true };
  }

  async addComment(noteId: string, authorId: string, content: string) {
    const note = await this.prisma.note.findUnique({ where: { id: noteId } });
    if (!note) throw new NotFoundException(`Note ${noteId} not found`);

    return this.prisma.noteComment.create({
      data: { noteId, authorId, content },
      include: { author: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });
  }
}
