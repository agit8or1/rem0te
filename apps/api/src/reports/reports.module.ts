import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { MonitoringAdminService } from '../monitoring/monitoring-admin.service';

/**
 * MonitoringAdminService is provided here, as in DashboardModule, so the alert
 * reports call its alertWhere — the alerts list's own visibility rule —
 * instead of a copy that could drift from it. It is stateless.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, MonitoringAdminService],
})
export class ReportsModule {}
