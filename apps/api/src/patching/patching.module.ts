import { Module } from '@nestjs/common';
import { PatchingController } from './patching.controller';
import { PatchingService } from './patching.service';
import { PatchPolicyService } from './policies.service';

@Module({
  controllers: [PatchingController],
  providers: [PatchingService, PatchPolicyService],
})
export class PatchingModule {}
