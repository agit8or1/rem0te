import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';

// Global: the heartbeat asks it whether a chat is open, and the device routes
// (EnrollmentController) hand it the agent's polls and replies.
@Global()
@Module({
  imports: [AuditModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
