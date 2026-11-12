import { Global, Module } from '@nestjs/common';
import { UpdateMirrorController, UpdateTrustController } from './update-trust.controller';
import { UpdateTrustService } from './update-trust.service';
import { AgentMigrationService } from './agent-migration.service';

@Global()
@Module({
  controllers: [UpdateMirrorController, UpdateTrustController],
  providers: [UpdateTrustService, AgentMigrationService],
  exports: [UpdateTrustService, AgentMigrationService],
})
export class UpdateTrustModule {}
