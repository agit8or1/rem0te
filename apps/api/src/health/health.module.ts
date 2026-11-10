import { Module } from '@nestjs/common';
import { AuditChainModule } from '../audit/audit-chain.module';
import { HealthController } from './health.controller';

@Module({ imports: [AuditChainModule], controllers: [HealthController] })
export class HealthModule {}
