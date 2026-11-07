import { Module } from '@nestjs/common';
import { OffboardingService } from './offboarding.service';
import { AccessReviewService } from './access-review.service';
import { OffboardingController } from './offboarding.controller';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { EndpointsModule } from '../endpoints/endpoints.module';

@Module({
  imports: [AuditModule, RbacModule, EndpointsModule],
  controllers: [OffboardingController],
  providers: [OffboardingService, AccessReviewService],
})
export class OffboardingModule {}
