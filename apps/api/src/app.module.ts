import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from './common/guards/capabilities.guard';
import { THROTTLER_BURST, THROTTLER_MAIN } from './common/throttling';

import configuration from './config/configuration';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { MfaModule } from './mfa/mfa.module';
import { RbacModule } from './rbac/rbac.module';
import { AuditModule } from './audit/audit.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';
import { BusinessesModule } from './businesses/businesses.module';
import { SitesModule } from './sites/sites.module';
import { EndpointsModule } from './endpoints/endpoints.module';
import { SessionsModule } from './sessions/sessions.module';
import { LauncherModule } from './launcher/launcher.module';
import { EnrollmentModule } from './enrollment/enrollment.module';
import { NotesModule } from './notes/notes.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { GeoipModule } from './geoip/geoip.module';
import { AdminModule } from './admin/admin.module';
import { PublicModule } from './public/public.module';
import { ApiKeysModule } from './apikeys/apikeys.module';
import { PublicApiModule } from './public-api/public-api.module';
import { PlatformModule } from './platform/platform.module';
import { QuickConnectModule } from './quick-connect/quick-connect.module';
import { DownloadsModule } from './downloads/downloads.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env'],
    }),
    // Names matter: a route's @Throttle/RateLimit override is matched to a
    // throttler by name, and an override naming a throttler that does not
    // exist is silently ignored. Both names come from common/throttling.ts,
    // which is also where RateLimit() builds its key.
    ThrottlerModule.forRoot([
      {
        name: THROTTLER_BURST,
        ttl: 1000,
        limit: 20,
      },
      {
        name: THROTTLER_MAIN,
        ttl: 60000,
        limit: 300,
      },
    ]),
    PrismaModule,
    CommonModule,
    RbacModule,
    AuditModule,
    AuthModule,
    MfaModule,
    TenantsModule,
    UsersModule,
    BusinessesModule,
    SitesModule,
    EndpointsModule,
    SessionsModule,
    LauncherModule,
    EnrollmentModule,
    NotesModule,
    DashboardModule,
    GeoipModule,
    AdminModule,
    PublicModule,
    ApiKeysModule,
    PublicApiModule,
    PlatformModule,
    QuickConnectModule,
    DownloadsModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CapabilitiesGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
