import { Module } from '@nestjs/common';
import { PatchingController } from './patching.controller';
import { PatchingService } from './patching.service';
import { PatchPolicyService } from './policies.service';
import { PatchSeriesService } from './series.service';

@Module({
  controllers: [PatchingController],
  providers: [PatchingService, PatchPolicyService, PatchSeriesService],
})
export class PatchingModule {}
