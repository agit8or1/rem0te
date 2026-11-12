import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportSchedulesController } from './report-schedules.controller';
import { ReportSchedulesService } from './report-schedules.service';
import { MonitoringAdminService } from '../monitoring/monitoring-admin.service';

/**
 * MonitoringAdminService is provided here, as in DashboardModule, so the alert
 * reports call its alertWhere — the alerts list's own visibility rule —
 * instead of a copy that could drift from it. It is stateless.
 */
@Module({
  // ReportSchedulesController first: its `schedules` path must not be read as a report name.
  controllers: [ReportSchedulesController, ReportsController],
  providers: [ReportsService, ReportSchedulesService, MonitoringAdminService],
})
export class ReportsModule {}
