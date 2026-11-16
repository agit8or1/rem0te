import { Global, Module } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { MonitoringAdminService } from './monitoring-admin.service';
import { AlertEventsService } from './alert-events.service';
import { MonitoringController } from './monitoring.controller';
import { AlertTicketsService } from './alert-tickets.service';
import { PsaModule } from '../psa/psa.module';

// Global: the heartbeat, the inventory pass and the integration API feed it.
@Global()
// 0.55: PsaModule for automatic alert tickets (AlertTicketsService, run by the sweep).
@Module({
  imports: [PsaModule],
  controllers: [MonitoringController],
  providers: [MonitoringService, MonitoringAdminService, AlertEventsService, AlertTicketsService],
  exports: [MonitoringService, AlertEventsService],
})
export class MonitoringModule {}
