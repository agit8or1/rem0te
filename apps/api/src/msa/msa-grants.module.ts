import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { MsaAgentController, MsaGrantsController } from './msa-grant.controller';
import { MsaManagedController } from './msa-managed.controller';
import { MsaSessionsController } from './msa-sessions.controller';
import { MsaCutoverRunsController } from './msa-cutover-runs.controller';
import { MsaGrantService } from './msa-grant.service';
import { MsaManagedService } from './msa-managed.service';
import { MsaSessionService } from './msa-sessions.service';
import { MsaCutoverRunService } from './msa-cutover-runs.service';
import { MsaGrantsGate } from './msa-grants-flag';

/**
 * Managed Secure Access grants and the long-poll channel (0.71, build step
 * 3), cutover, enforcement reports and rollback (0.72, step 4), and Connect
 * through grants, revocation, session evidence and cutover runs (0.73, step
 * 5), behind MSA_GRANTS, off. Not exported: nothing outside this module can
 * issue a grant, revoke one or move a computer (§81, §82, §83). Connect
 * reaches it only through its own gated route (msa/sessions).
 */
@Module({
  imports: [RbacModule, EnrollmentModule, EndpointsModule],
  controllers: [MsaGrantsController, MsaAgentController, MsaManagedController, MsaSessionsController, MsaCutoverRunsController],
  providers: [MsaGrantService, MsaManagedService, MsaSessionService, MsaCutoverRunService],
})
export class MsaGrantsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MsaGrantsGate).forRoutes(MsaGrantsController, MsaAgentController, MsaManagedController, MsaSessionsController, MsaCutoverRunsController);
  }
}
