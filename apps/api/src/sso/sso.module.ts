import { Module } from '@nestjs/common';
import { SsoService } from './sso.service';
import { SsoAdminController, SsoAuthController } from './sso.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [SsoAdminController, SsoAuthController],
  providers: [SsoService],
})
export class SsoModule {}
