import { Global, Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { AgentAutoUpdateController } from './agent-auto-update.controller';
import { AgentAutoUpdateService } from './agent-auto-update.service';

// Automatic agent self-update (0.36). Global: the heartbeat asks it whether to
// add an update flag, and the Agent card asks it what to say.
@Global()
@Module({
  imports: [RbacModule],
  controllers: [AgentAutoUpdateController],
  providers: [AgentAutoUpdateService],
  exports: [AgentAutoUpdateService],
})
export class AgentAutoUpdateModule {}
