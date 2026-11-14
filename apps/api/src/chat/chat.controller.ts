import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Response } from 'express';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ChatService, type UploadedChatFile } from './chat.service';
import { ChatInboxService } from './chat-inbox.service';
import { MAX_ATTACHMENT_BYTES, attachmentHeaders } from './chat-attachment';

/**
 * One file per request, held in memory (never written to disk), at most
 * 10 MB — multer stops reading past that and the request is a 413. It runs
 * after the class's guards, so an unauthenticated request or one without the
 * capability is refused before a byte is buffered. The declared type is not
 * consulted: chat-attachment.ts classifies the bytes.
 */
export const CHAT_UPLOAD = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1, fields: 4, fieldSize: 1024, parts: 6 },
});

/** An attachment, served inert: its sniffed image type inline, or an octet-stream download; nosniff and a sandbox CSP either way. */
export function sendAttachment(res: Response, a: { kind: string; contentType: string; fileName: string; sizeBytes: number; bytes: Uint8Array }) {
  for (const [k, v] of Object.entries(attachmentHeaders(a))) res.setHeader(k, v);
  res.end(Buffer.from(a.bytes));
}

export class StartChatDto {
  @IsOptional() @IsString() @Length(1, 40) supportRequestId?: string;
}

/** Generous here; the service applies the 2,000-character rule after normalising line endings and controls. */
export class ChatMessageDto {
  @IsString() @Length(1, 8000) text!: string;
}

/** Replies from the person at the computer that the panel has shown (0.36). */
export class ChatAckDto {
  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) ids!: string[];
}

/**
 * Chat (0.34), the technician side, in the device workspace. Reading needs
 * `computers:view` (a transcript belongs to the computer); starting, writing
 * and ending need `support:chat` on that computer. Every route checks scope
 * and visibility in the service: another business's computer is a 404.
 */
@Controller('endpoints/:id/chat')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async overview(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.chat.overview(actor, id) };
  }

  @Get('conversations/:cid')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async transcript(@Actor() actor: ActorContext, @Param('id') id: string, @Param('cid') cid: string, @Query('after') after?: string) {
    return { success: true, data: await this.chat.transcript(actor, id, cid, after) };
  }

  @Post('conversations')
  @RequireCapability(CAP.CHAT_SEND)
  @RateLimit(20)
  async start(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: StartChatDto) {
    return { success: true, data: await this.chat.start(actor, id, dto) };
  }

  @Post('conversations/:cid/messages')
  @RequireCapability(CAP.CHAT_SEND)
  @RateLimit(60)
  async send(@Actor() actor: ActorContext, @Param('id') id: string, @Param('cid') cid: string, @Body() dto: ChatMessageDto) {
    return { success: true, data: await this.chat.send(actor, id, cid, dto) };
  }

  /** A file or image (0.44), multipart `file`. */
  @Post('conversations/:cid/attachments')
  @RequireCapability(CAP.CHAT_SEND)
  @RateLimit(20)
  @UseInterceptors(CHAT_UPLOAD)
  async upload(@Actor() actor: ActorContext, @Param('id') id: string, @Param('cid') cid: string, @UploadedFile() file: UploadedChatFile) {
    return { success: true, data: await this.chat.sendAttachment(actor, id, cid, file) };
  }

  /** The file (0.44): whoever may read the transcript may read it. */
  @Get('conversations/:cid/attachments/:aid')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(120)
  async attachment(@Actor() actor: ActorContext, @Param('id') id: string, @Param('cid') cid: string, @Param('aid') aid: string, @Res() res: Response) {
    sendAttachment(res, await this.chat.readAttachment(actor, id, cid, aid));
  }

  /** The panel showed these replies (0.36). In a chat that is not recorded, that deletes them. */
  @Post('conversations/:cid/ack')
  @RequireCapability(CAP.CHAT_SEND)
  @RateLimit(120)
  @HttpCode(HttpStatus.OK)
  async ack(@Actor() actor: ActorContext, @Param('id') id: string, @Param('cid') cid: string, @Body() dto: ChatAckDto) {
    return { success: true, data: await this.chat.ack(actor, id, cid, dto) };
  }

  @Post('conversations/:cid/end')
  @RequireCapability(CAP.CHAT_SEND)
  @HttpCode(HttpStatus.OK)
  async end(@Actor() actor: ActorContext, @Param('id') id: string, @Param('cid') cid: string) {
    return { success: true, data: await this.chat.end(actor, id, cid) };
  }
}

export class ChatReadDto {
  @IsString() @Length(1, 40) conversationId!: string;
  @IsOptional() @IsString() @Length(1, 40) upTo?: string;
}

/**
 * The console's chat inbox (0.44): the header's chat icon, the toasts and the
 * title count, wherever the technician is in the app. Only chats on
 * computers the caller can see (endpointVisibilityWhere), only with
 * computers:view; read marks are the caller's own.
 */
@Controller('chat/inbox')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ChatInboxController {
  constructor(private readonly inbox: ChatInboxService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  async list(@Actor() actor: ActorContext, @Query('since') since?: string) {
    return { success: true, data: await this.inbox.inbox(actor, typeof since === 'string' ? since.slice(0, 64) : undefined) };
  }

  @Post('read')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(120)
  @HttpCode(HttpStatus.OK)
  async read(@Actor() actor: ActorContext, @Body() dto: ChatReadDto) {
    return { success: true, data: await this.inbox.markRead(actor, dto.conversationId, dto.upTo) };
  }
}
