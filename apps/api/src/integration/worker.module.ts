import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../config/configuration';
import { PrismaModule } from '../prisma/prisma.module';
import { RbacModule } from '../rbac/rbac.module';
import { AuditModule } from '../audit/audit.module';
import { DelegationService } from './delegation.service';
import { ReplayGuardService } from './replay-guard.service';
import { IntegrationWorkerService } from './worker.service';

/**
 * Everything the standalone worker process loads — and nothing else. No
 * HTTP server, no sessions, launcher, enrollment, endpoint commands or admin
 * modules exist in this process, so there is no code path from a job to any
 * of them. scripts/check-security-invariants.mjs keeps this list short.
 */
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, load: [configuration], envFilePath: ['.env'] }), PrismaModule, RbacModule, AuditModule],
  providers: [DelegationService, ReplayGuardService, IntegrationWorkerService],
})
export class IntegrationWorkerModule {}
