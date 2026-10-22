import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LauncherService } from './launcher.service';
import { LauncherController } from './launcher.controller';
import { AuditModule } from '../audit/audit.module';
import { EndpointsModule } from '../endpoints/endpoints.module';
import { QuickConnectModule } from '../quick-connect/quick-connect.module';

@Module({
  imports: [
    JwtModule.register({}), // Secrets passed per-call via options
    AuditModule,
    EndpointsModule,
    QuickConnectModule,
  ],
  controllers: [LauncherController],
  providers: [LauncherService],
  exports: [LauncherService],
})
export class LauncherModule {}
