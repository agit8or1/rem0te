import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { BusinessesModule } from '../businesses/businesses.module';
import { SitesModule } from '../sites/sites.module';
import { UsersModule } from '../users/users.module';
import { RbacModule } from '../rbac/rbac.module';
import { MonitoringAdminService } from '../monitoring/monitoring-admin.service';

/**
 * MonitoringAdminService is provided here, as in DashboardModule and
 * ReportsModule, so the alerts group calls alertWhere — the alerts list's own
 * visibility rule — instead of a copy. It is stateless.
 */
@Module({
  imports: [EndpointsModule, BusinessesModule, SitesModule, UsersModule, RbacModule],
  controllers: [SearchController],
  providers: [SearchService, MonitoringAdminService],
})
export class SearchModule {}
