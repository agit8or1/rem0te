import { Module } from '@nestjs/common';
import { PortalController } from './portal.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [PrismaModule, SessionsModule],
  controllers: [PortalController],
})
export class PortalModule {}
