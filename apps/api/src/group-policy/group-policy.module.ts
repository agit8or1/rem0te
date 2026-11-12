import { Global, Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { GroupMembershipService } from './membership.service';

// Global: monitoring and client updates both decide group-scoped policies
// with it. It has no controller — membership is never served on its own.
@Global()
@Module({
  imports: [RbacModule, EndpointsModule],
  providers: [GroupMembershipService],
  exports: [GroupMembershipService],
})
export class GroupPolicyModule {}
