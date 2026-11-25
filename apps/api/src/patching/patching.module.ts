import { Module } from '@nestjs/common';
import { PatchingController } from './patching.controller';
import { PatchingService } from './patching.service';
import { PatchPolicyService } from './policies.service';
import { PatchSeriesService } from './series.service';

@Module({
  controllers: [PatchingController],
  providers: [PatchingService, PatchPolicyService, PatchSeriesService],
  // 0.87: global search reads policies through PatchPolicyService.findVisibleByName (scoped()).
  exports: [PatchPolicyService],
})
export class PatchingModule {}
