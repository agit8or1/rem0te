import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { AgentMigrationsController, AgentUpgradeController } from './agent-upgrade.controller';
import { AgentUpgradeService } from './agent-upgrade.service';

// The Agent card and per-computer agent upgrade (0.34). The migration store,
// the heartbeat step and the windows.ps1 script live in UpdateTrustModule
// (global); this module calls into them and into EndpointsService's reinstall.
// Exported for the bulk-actions path.
@Module({
  imports: [RbacModule, EndpointsModule],
  controllers: [AgentUpgradeController, AgentMigrationsController],
  providers: [AgentUpgradeService],
  exports: [AgentUpgradeService],
})
export class AgentUpgradeModule {}
