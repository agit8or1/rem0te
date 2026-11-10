import { Module } from '@nestjs/common';
import { PatchingController } from './patching.controller';
import { PatchingService } from './patching.service';

@Module({
  controllers: [PatchingController],
  providers: [PatchingService],
})
export class PatchingModule {}
