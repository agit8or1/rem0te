import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { UpdateController } from './update.controller';
import { UpdateService } from './update.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [AdminController, SecurityController, UpdateController],
  providers: [AdminService, SecurityService, UpdateService],
})
export class AdminModule {}
