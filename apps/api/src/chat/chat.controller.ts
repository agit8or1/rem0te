import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsOptional, IsString, Length } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ChatService } from './chat.service';

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
