import { Global, Module } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { MonitoringAdminService } from './monitoring-admin.service';
import { AlertEventsService } from './alert-events.service';
import { MonitoringController } from './monitoring.controller';
import { AlertTicketsService } from './alert-tickets.service';
import { PsaModule } from '../psa/psa.module';
import { AlertQualityService } from './alert-quality.service';

// Global: the heartbeat, the inventory pass and the integration API feed it.
@Global()
// 0.55: PsaModule for automatic alert tickets (AlertTicketsService, run by the sweep).
@Module({
  imports: [PsaModule],
  controllers: [MonitoringController],
  // 0.66: AlertQualityService corrects the pre-0.66 disk-errors monitor and reclassifies open event alerts, once, on start.
  providers: [MonitoringService, MonitoringAdminService, AlertEventsService, AlertTicketsService, AlertQualityService],
  exports: [MonitoringService, AlertEventsService],
})
export class MonitoringModule {}
