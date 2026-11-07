import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { AccessControlService } from './access-control.service';
import { TechnicianAccessService } from './technician-access.service';
import { ActorResolverService } from './actor-resolver.service';

@Global()
@Module({
  providers: [RbacService, AccessControlService, TechnicianAccessService, ActorResolverService],
  exports: [RbacService, AccessControlService, TechnicianAccessService, ActorResolverService],
})
export class RbacModule {}
