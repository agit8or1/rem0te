import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ScriptRunController } from './script-run.controller';
import { ScriptRunService } from './script-run.service';

// ActionsService and SignerClient come from the global ActionsModule. Nothing
// is exported: the run path is these four routes and the heartbeat's own
// delivery in ActionsService, nothing else.
@Module({
  imports: [AuditModule],
  controllers: [ScriptRunController],
  providers: [ScriptRunService],
})
export class ScriptRunModule {}
