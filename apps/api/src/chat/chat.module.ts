import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ChatController, ChatInboxController } from './chat.controller';
import { ChatInboxService } from './chat-inbox.service';
import { ChatService } from './chat.service';

// Global: the heartbeat asks it whether a chat is open, and the device routes
// (EnrollmentController) hand it the agent's polls and replies.
@Global()
@Module({
  imports: [AuditModule],
  controllers: [ChatController, ChatInboxController],
  providers: [ChatService, ChatInboxService],
  exports: [ChatService],
})
export class ChatModule {}
