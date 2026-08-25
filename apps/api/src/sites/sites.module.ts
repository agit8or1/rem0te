import { Module } from '@nestjs/common';
import { SitesService } from './sites.service';
import { SitesController, BusinessSitesController } from './sites.controller';
import { AuditModule } from '../audit/audit.module';
import { RbacModule } from '../rbac/rbac.module';

@Module({
  imports: [AuditModule, RbacModule],
  controllers: [BusinessSitesController, SitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
