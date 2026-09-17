import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EndpointsService } from './endpoints.service';
import { EndpointsController } from './endpoints.controller';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';
import { EndpointInventoryModule } from '../endpoint-inventory/endpoint-inventory.module';

@Module({
  imports: [AuditModule, RbacModule, ConfigModule, EndpointInventoryModule],
  controllers: [EndpointsController],
  providers: [EndpointsService],
  exports: [EndpointsService],
})
export class EndpointsModule {}
