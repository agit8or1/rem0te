import { Global, Module } from '@nestjs/common';
import { SupportRequestsService } from './support-requests.service';
import { PublicSupportController, SupportRequestsController } from './support-requests.controller';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';

/** Global so Quick Connect can validate a request id without a module cycle. */
@Global()
@Module({
  imports: [AuditModule, RbacModule],
  controllers: [SupportRequestsController, PublicSupportController],
  providers: [SupportRequestsService],
  exports: [SupportRequestsService],
})
export class SupportRequestsModule {}
