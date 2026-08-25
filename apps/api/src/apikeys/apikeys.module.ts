import { Module } from '@nestjs/common';
import { ApiKeysService } from './apikeys.service';
import { ApiKeysController } from './apikeys.controller';
import { ApiKeyAuthGuard } from './apikey-auth.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [ApiKeysService, ApiKeyAuthGuard],
  controllers: [ApiKeysController],
  exports: [ApiKeysService, ApiKeyAuthGuard],
})
export class ApiKeysModule {}
