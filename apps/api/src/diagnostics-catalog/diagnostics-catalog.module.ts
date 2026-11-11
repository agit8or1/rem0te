import { Global, Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { EndpointInventoryModule } from '../endpoint-inventory/endpoint-inventory.module';
import { DiagnosticsCatalogController } from './diagnostics-catalog.controller';
import { DiagnosticsCatalogService } from './diagnostics-catalog.service';

// Global: the enrollment heartbeat hands runs out and takes their results.
@Global()
@Module({
  imports: [AuditModule, EndpointInventoryModule],
  controllers: [DiagnosticsCatalogController],
  providers: [DiagnosticsCatalogService],
  exports: [DiagnosticsCatalogService],
})
export class DiagnosticsCatalogModule {}
