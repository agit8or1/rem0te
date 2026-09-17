import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { UpdateController } from './update.controller';
import { UpdateService } from './update.service';
import { HostMetricsService } from './host-metrics.service';

@Module({
  controllers: [AdminController, SecurityController, UpdateController],
  providers: [AdminService, SecurityService, UpdateService, HostMetricsService],
})
export class AdminModule {}
