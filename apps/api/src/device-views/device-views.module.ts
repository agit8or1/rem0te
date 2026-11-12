import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { AdminModule } from '../admin/admin.module';
import { AgentUpgradeModule } from '../agent-upgrade/agent-upgrade.module';
import { DeviceBulkController, DeviceGroupsController, DeviceViewsController } from './device-views.controller';
import { SavedViewsService } from './saved-views.service';
import { DeviceGroupsService } from './device-groups.service';
import { DeviceBulkService } from './device-bulk.service';

// Device groups, saved views and bulk actions (0.33). Exports nothing: the
// bulk service calls INTO the single-computer services, never the reverse.
@Module({
  imports: [AuditModule, RbacModule, EndpointsModule, AdminModule, AgentUpgradeModule],
  controllers: [DeviceViewsController, DeviceGroupsController, DeviceBulkController],
  providers: [SavedViewsService, DeviceGroupsService, DeviceBulkService],
})
export class DeviceViewsModule {}
