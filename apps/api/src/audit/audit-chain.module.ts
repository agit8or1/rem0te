import { Module } from '@nestjs/common';
import { AuditChainService } from './audit-chain.service';
import { AuditChainController } from './audit-chain.controller';

// The API process only: the sealer is not loaded by the integration worker
// (which imports AuditModule to write entries, not to seal them).
@Module({ controllers: [AuditChainController], providers: [AuditChainService], exports: [AuditChainService] })
export class AuditChainModule {}
