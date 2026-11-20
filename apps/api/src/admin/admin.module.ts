import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { UpdateController } from './update.controller';
import { RolloutsController } from './rollouts.controller';
import { UpdateService } from './update.service';
import { HostMetricsService } from './host-metrics.service';
import { HostRunner } from './host-security/host-runner';
import { AuditChainModule } from '../audit/audit-chain.module';

@Module({
  // AuditChainModule: the Security page's posture reads the chain's status (0.74).
  imports: [AuditChainModule],
  controllers: [AdminController, SecurityController, UpdateController, RolloutsController],
  providers: [AdminService, SecurityService, UpdateService, HostMetricsService, HostRunner],
  // UpdateService: the device list's bulk client update (0.33) stages through it.
  exports: [UpdateService],
})
export class AdminModule {}
