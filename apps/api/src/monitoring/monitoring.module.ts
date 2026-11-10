import { Global, Module } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { MonitoringAdminService } from './monitoring-admin.service';
import { AlertEventsService } from './alert-events.service';
import { MonitoringController } from './monitoring.controller';

// Global: the heartbeat, the inventory pass and the integration API feed it.
@Global()
@Module({
  controllers: [MonitoringController],
  providers: [MonitoringService, MonitoringAdminService, AlertEventsService],
  exports: [MonitoringService, AlertEventsService],
})
export class MonitoringModule {}
