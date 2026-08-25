import { Global, Module } from '@nestjs/common';
import { RbacService } from './rbac.service';
import { AccessControlService } from './access-control.service';

@Global()
@Module({
  providers: [RbacService, AccessControlService],
  exports: [RbacService, AccessControlService],
})
export class RbacModule {}
