import { Module } from '@nestjs/common';
import { SsoService } from './sso.service';
import { SsoAdminController, SsoAuthController } from './sso.controller';
import { SsoSessionService } from './sso-session.service';
import { SsoIdentityService } from './sso-identity.service';
import { SsoIdentityController } from './sso-identity.controller';
import { AuthModule } from '../auth/auth.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [SsoAdminController, SsoAuthController, SsoIdentityController],
  providers: [SsoService, SsoSessionService, SsoIdentityService],
})
export class SsoModule {}
