import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AutomationModule } from '../automation/automation.module';
import { RestartWindowsController } from './restart-windows.controller';
import { RestartWindowsService } from './restart-windows.service';

/** Restart windows (0.60). Each window is an automation policy (AutomationModule); ActionsService, group membership and containment come from global modules. */
@Module({
  imports: [AuditModule, AutomationModule],
  controllers: [RestartWindowsController],
  providers: [RestartWindowsService],
})
export class RestartWindowsModule {}
