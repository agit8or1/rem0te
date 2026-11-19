import { Global, Module } from '@nestjs/common';
import { RbacModule } from '../rbac/rbac.module';
import { MsaController } from './msa.controller';
import { MsaService } from './msa.service';

// Managed Secure Access readiness (0.69). Global: the heartbeat
// (EnrollmentService) hands it the signed agent's preflight.
@Global()
@Module({
  imports: [RbacModule],
  controllers: [MsaController],
  providers: [MsaService],
  exports: [MsaService],
})
export class MsaModule {}
