import { Global, Module } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';
import { MonitoringAdminService } from './monitoring-admin.service';
import { AlertEventsService } from './alert-events.service';
import { MonitoringController } from './monitoring.controller';
import { AlertTicketsService } from './alert-tickets.service';
import { PsaModule } from '../psa/psa.module';
import { AlertQualityService } from './alert-quality.service';
import { QualityEngineService } from './quality-engine.service';
import { QualityRulesService } from './quality-rules.service';
import { FalsePositiveService } from './false-positive.service';
import { AlertQualityController } from './alert-quality.controller';

// Global: the heartbeat, the inventory pass and the integration API feed it.
@Global()
// 0.55: PsaModule for automatic alert tickets (AlertTicketsService, run by the sweep).
@Module({
  imports: [PsaModule],
  controllers: [MonitoringController, AlertQualityController],
  // 0.66: AlertQualityService corrects the pre-0.66 disk-errors monitor and reclassifies open event alerts, once, on start.
  // 0.67: the alert quality rules (engine: evaluation on the ingest path; rules: management) and false-positive reports.
  providers: [MonitoringService, MonitoringAdminService, AlertEventsService, AlertTicketsService, AlertQualityService, QualityEngineService, QualityRulesService, FalsePositiveService],
  exports: [MonitoringService, AlertEventsService],
})
export class MonitoringModule {}
