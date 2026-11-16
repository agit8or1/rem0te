import { Module } from '@nestjs/common';
import { WarrantyController, WarrantySettingsController } from './warranty.controller';
import { WarrantyService } from './warranty.service';

/** Hardware warranty and support links (0.56). The only module that calls a vendor warranty API (invariant §69). */
@Module({
  controllers: [WarrantySettingsController, WarrantyController],
  providers: [WarrantyService],
})
export class WarrantyModule {}
