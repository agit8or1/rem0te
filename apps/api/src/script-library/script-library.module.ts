import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ScriptLibraryController } from './script-library.controller';
import { ScriptLibraryService } from './script-library.service';
import { ApprovalModeProbe } from '../actions/approval-mode';

// Not global, and exports nothing: no other module has any business calling
// into the library, and the library calls into nothing that reaches a computer.
// ApprovalModeProbe (0.40) answers one read-only question of the approval
// signer: whether its default policy is in direct mode.
@Module({
  imports: [AuditModule],
  controllers: [ScriptLibraryController],
  providers: [ScriptLibraryService, ApprovalModeProbe],
})
export class ScriptLibraryModule {}
