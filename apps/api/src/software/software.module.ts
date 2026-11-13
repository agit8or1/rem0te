import { Module } from '@nestjs/common';
import { SoftwareController } from './software.controller';
import { SoftwareService } from './software.service';
import { WingetIndexService } from './winget-index.service';

/** Software deployment (0.34) and the searchable winget catalog (0.41). ActionsService and SignerClient come from the global ActionsModule. */
@Module({
  controllers: [SoftwareController],
  providers: [SoftwareService, WingetIndexService],
  exports: [SoftwareService],
})
export class SoftwareModule {}
