import { Global, Module } from '@nestjs/common';
import { ClientUpdatesController } from './client-updates.controller';
import { ClientUpdatesService } from './client-updates.service';
import { ClientUpdateSweepService } from './client-update-sweep.service';

// Global: the heartbeat asks it whether a POLICY-queued update may go now.
@Global()
@Module({
  controllers: [ClientUpdatesController],
  providers: [ClientUpdatesService, ClientUpdateSweepService],
  exports: [ClientUpdatesService],
})
export class ClientUpdatesModule {}
