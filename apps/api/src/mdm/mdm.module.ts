import { Module } from '@nestjs/common';
import { MdmController } from './mdm.controller';
import { MdmService } from './mdm.service';
import { MdmSyncService } from './mdm-sync.service';

/** Mobile devices through an MDM provider (0.80 Tablet). Read-only; the only module that reads a provider (§90). */
@Module({
  controllers: [MdmController],
  providers: [MdmService, MdmSyncService],
})
export class MdmModule {}
