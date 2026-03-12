import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';

import configuration from './config/configuration';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { MfaModule } from './mfa/mfa.module';
import { RbacModule } from './rbac/rbac.module';
import { AuditModule } from './audit/audit.module';
import { TenantsModule } from './tenants/tenants.module';
import { UsersModule } from './users/users.module';
import { CustomersModule } from './customers/customers.module';
import { SitesModule } from './sites/sites.module';
import { EndpointsModule } from './endpoints/endpoints.module';
import { SessionsModule } from './sessions/sessions.module';
import { LauncherModule } from './launcher/launcher.module';
import { EnrollmentModule } from './enrollment/enrollment.module';
import { NotesModule } from './notes/notes.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AdminModule } from './admin/admin.module';
import { PublicModule } from './public/public.module';
import { PortalModule } from './portal/portal.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env'],
    }),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 20,
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 300,
      },
    ]),
    PrismaModule,
    RbacModule,
    AuditModule,
    AuthModule,
    MfaModule,
    TenantsModule,
    UsersModule,
    CustomersModule,
    SitesModule,
    EndpointsModule,
    SessionsModule,
    LauncherModule,
    EnrollmentModule,
    NotesModule,
    DashboardModule,
    AdminModule,
    PublicModule,
    PortalModule,
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
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
