import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { AgentAutoMigrationController, AgentSigningController } from './agent-auto-migration.controller';
import { AgentAutoMigrationService } from './agent-auto-migration.service';

// Automatic migration to the signed agent and the Full agent page (0.37).
@Module({
  imports: [RbacModule],
  controllers: [AgentSigningController, AgentAutoMigrationController],
  providers: [AgentAutoMigrationService],
})
export class AgentAutoMigrationModule {}
