import { Module } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { DashboardOverviewService } from './overview.service';
import { DashboardController } from './dashboard.controller';
import { MonitoringAdminService } from '../monitoring/monitoring-admin.service';

/**
 * MonitoringAdminService is provided here (it is stateless: no timers, no
 * caches) so the overview can call its alertWhere — the alerts list's own
 * visibility rule — instead of a copy that could drift from it. The
 * monitoring module does not export it, and its dependencies are global.
 */
@Module({
  controllers: [DashboardController],
  providers: [DashboardService, DashboardOverviewService, MonitoringAdminService],
})
export class DashboardModule {}
