import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EnrollmentService } from './enrollment.service';
import { EnrollmentController } from './enrollment.controller';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule, ConfigModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService],
  exports: [EnrollmentService],
})
export class EnrollmentModule {}
