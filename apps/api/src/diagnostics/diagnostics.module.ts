import { Module } from '@nestjs/common';
import { DiagnosticsService } from './diagnostics.service';
import { DiagnosticsController } from './diagnostics.controller';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { CommonModule } from '../common/common.module';
import { EnrollmentModule } from '../enrollment/enrollment.module';

@Module({
  imports: [AuditModule, RbacModule, CommonModule, EnrollmentModule],
  controllers: [DiagnosticsController],
  providers: [DiagnosticsService],
})
export class DiagnosticsModule {}
