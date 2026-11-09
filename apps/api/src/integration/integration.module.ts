import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IntegrationController } from './integration.controller';
import { IntegrationAdminController } from './integration-admin.controller';
import { IntegrationAuthGuard } from './integration-auth.guard';
import { IntegrationJobsService } from './jobs.service';
import { DelegationService } from './delegation.service';
import { ReplayGuardService } from './replay-guard.service';
import { IntegrationWorkerService } from './worker.service';

/**
 * API-side integration: intake, polling and mapping administration. The
 * worker normally runs as its own process (worker.main.ts, systemd unit
 * reboot-remote-integration-worker); INTEGRATION_WORKER_INLINE=true runs it
 * in the API process instead, for a single-box lab.
 */
@Module({
  imports: [AuditModule],
  controllers: [IntegrationController, IntegrationAdminController],
  providers: [IntegrationAuthGuard, IntegrationJobsService, DelegationService, ReplayGuardService, IntegrationWorkerService],
})
export class IntegrationModule implements OnApplicationBootstrap {
  constructor(private readonly worker: IntegrationWorkerService) {}
  onApplicationBootstrap() {
    if (process.env.INTEGRATION_WORKER_INLINE === 'true') this.worker.start();
  }
}
