import { Module } from '@nestjs/common';
import { MdmController } from './mdm.controller';
import { MdmService } from './mdm.service';
import { MdmSyncService } from './mdm-sync.service';
import { MdmSetupController } from './setup/mdm-setup.controller';
import { MdmSetupService } from './setup/mdm-setup.service';

/** Mobile devices through an MDM provider (0.80 Tablet). Read-only; the only module that reads a provider (§90). */
@Module({
  // 0.83: Settings → Mobile devices (mdm/setup/, §92), Platform Admin only.
  controllers: [MdmSetupController, MdmController],
  providers: [MdmService, MdmSyncService, MdmSetupService],
})
export class MdmModule {}
