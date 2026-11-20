import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';
import { MsaAgentController, MsaGrantsController } from './msa-grant.controller';
import { MsaGrantService } from './msa-grant.service';
import { MsaGrantsGate } from './msa-grants-flag';

/**
 * Managed Secure Access grants and the long-poll channel (0.71, build step
 * 3), behind MSA_GRANTS, off. Not exported: nothing outside this module —
 * Connect included — can issue a grant (§81).
 */
@Module({
  imports: [RbacModule, EnrollmentModule],
  controllers: [MsaGrantsController, MsaAgentController],
  providers: [MsaGrantService],
})
export class MsaGrantsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(MsaGrantsGate).forRoutes(MsaGrantsController, MsaAgentController);
  }
}
