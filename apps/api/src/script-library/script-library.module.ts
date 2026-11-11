import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ScriptLibraryController } from './script-library.controller';
import { ScriptLibraryService } from './script-library.service';

// Not global, and exports nothing: no other module has any business calling
// into the library, and the library calls into nothing that reaches a computer.
@Module({
  imports: [AuditModule],
  controllers: [ScriptLibraryController],
  providers: [ScriptLibraryService],
})
export class ScriptLibraryModule {}
