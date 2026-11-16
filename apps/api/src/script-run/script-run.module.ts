import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ScriptRunController } from './script-run.controller';
import { ScriptRunService } from './script-run.service';

// ActionsService and SignerClient come from the global ActionsModule. The run
// path is these four routes and the heartbeat's own delivery in
// ActionsService. 0.58: the service is exported for the automation module,
// which uses only automationTask / automationScriptProblem (they request
// nothing) to build and check an automation policy's script task.
@Module({
  imports: [AuditModule],
  controllers: [ScriptRunController],
  providers: [ScriptRunService],
  exports: [ScriptRunService],
})
export class ScriptRunModule {}
