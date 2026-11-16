import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ScriptRunModule } from '../script-run/script-run.module';
import { SoftwareModule } from '../software/software.module';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';

/** Automation schedules (0.58). ActionsService and SignerClient come from the global ActionsModule; group membership from the global GroupPolicyModule. */
@Module({
  imports: [AuditModule, ScriptRunModule, SoftwareModule],
  controllers: [AutomationController],
  providers: [AutomationService],
})
export class AutomationModule {}
