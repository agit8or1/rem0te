import { Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { RemoteAgentController, RemoteOpsSettingsController, TerminalController } from './terminal.controller';
import { TerminalService } from './terminal.service';
import { RemoteAgentService } from './remote-agent.service';
import { RemoteOpsSettingsService } from './remote-ops-settings.service';
import { RemoteWakeService } from './remote-wake.service';

/**
 * Background remote operations (0.77 Conduit: the terminal). Not exported:
 * nothing outside this module opens, feeds or ends a terminal. The heartbeat
 * reads only whether a computer has work (remote-ops/presence.ts, a plain
 * query) to say `remotePoll`.
 */
@Module({
  imports: [RbacModule, EnrollmentModule],
  controllers: [TerminalController, RemoteAgentController, RemoteOpsSettingsController],
  providers: [TerminalService, RemoteAgentService, RemoteOpsSettingsService, RemoteWakeService],
})
export class RemoteOpsModule {}
