import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { AssistController, ChatRecordingController, EndpointTrayController, TrayDeviceController } from './tray.controller';
import { TrayService } from './tray.service';
import { AssistService } from './assist.service';

// The tray (0.36): the tray's device routes, the /assist page, the computer's
// tray panel and the chat-recording settings. ChatService, ContainmentService
// and SupportRequestsService are global.
@Module({
  imports: [AuditModule, RbacModule, EnrollmentModule],
  controllers: [TrayDeviceController, EndpointTrayController, ChatRecordingController, AssistController],
  providers: [TrayService, AssistService],
  exports: [TrayService],
})
export class TrayModule {}
