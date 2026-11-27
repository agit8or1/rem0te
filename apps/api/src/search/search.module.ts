import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { BusinessesModule } from '../businesses/businesses.module';
import { SitesModule } from '../sites/sites.module';
import { UsersModule } from '../users/users.module';
import { RbacModule } from '../rbac/rbac.module';
import { MonitoringAdminService } from '../monitoring/monitoring-admin.service';
// 0.92: MonitoringAdminService asks PsaService.configuredFor for an alert's ticket question; PsaService is not global.
import { PsaModule } from '../psa/psa.module';
import { PatchingModule } from '../patching/patching.module';
import { AutomationModule } from '../automation/automation.module';

/**
 * MonitoringAdminService is provided here, as in DashboardModule and
 * ReportsModule, so the alerts group calls alertWhere — the alerts list's own
 * visibility rule — instead of a copy. It is stateless.
 */
@Module({
  imports: [PsaModule, EndpointsModule, BusinessesModule, SitesModule, UsersModule, RbacModule, PatchingModule, AutomationModule],
  controllers: [SearchController],
  providers: [SearchService, MonitoringAdminService],
})
export class SearchModule {}
