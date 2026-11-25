import { Module } from '@nestjs/common';
import { NavigationController } from './navigation.controller';
import { NavigationService } from './navigation.service';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { BusinessesModule } from '../businesses/businesses.module';
import { SitesModule } from '../sites/sites.module';
import { RbacModule } from '../rbac/rbac.module';

/** 0.87: the person's own menu state. Reads records only through their pages' own where builders. */
@Module({
  imports: [EndpointsModule, BusinessesModule, SitesModule, RbacModule],
  controllers: [NavigationController],
  providers: [NavigationService],
})
export class NavigationModule {}
