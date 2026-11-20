import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { MsaAgentController, MsaGrantsController } from './msa-grant.controller';
import { MsaManagedController } from './msa-managed.controller';
import { MsaGrantService } from './msa-grant.service';
import { MsaManagedService } from './msa-managed.service';
import { MsaGrantsGate } from './msa-grants-flag';

/**
 * Managed Secure Access grants and the long-poll channel (0.71, build step
 * 3) and cutover, enforcement reports and rollback (0.72, step 4), behind
 * MSA_GRANTS, off. Not exported: nothing outside this module — Connect
 * included — can issue a grant or move a computer (§81, §82).
 */
@Module({
  imports: [RbacModule, EnrollmentModule, EndpointsModule],
  controllers: [MsaGrantsController, MsaAgentController, MsaManagedController],
  providers: [MsaGrantService, MsaManagedService],
})
export class MsaGrantsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MsaGrantsGate).forRoutes(MsaGrantsController, MsaAgentController, MsaManagedController);
  }
}
