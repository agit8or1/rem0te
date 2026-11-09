import { Global, Module } from '@nestjs/common';
import { AbuseGuardService } from './abuse-guard.service';
import { AccessPolicyService } from './access-policy.service';
import { SecurityAlertService } from './alerts.service';
import { ControlsStore } from './controls.store';
import { PolicyAdminService } from './policy-admin.service';
import { SecurityControlsController } from './security-controls.controller';
import { TemporaryAccessService } from './temporary-access.service';
import { TrustChangeService } from './trust-change.service';
import { SecurityFeaturesService } from './security-features.service';

// Global: the launch policy and the abuse guard are consulted from endpoints,
// sessions, the launcher, technicians and the integration worker alike.
@Global()
@Module({
  controllers: [SecurityControlsController],
  providers: [ControlsStore, SecurityAlertService, AbuseGuardService, AccessPolicyService, TrustChangeService, TemporaryAccessService, PolicyAdminService, SecurityFeaturesService],
  exports: [ControlsStore, SecurityAlertService, AbuseGuardService, AccessPolicyService, TrustChangeService, TemporaryAccessService],
})
export class SecurityControlsModule {}
