import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppleDeviceController, AppleAdminController } from './apple/apple.controller';
import { AppleEnrollmentService } from './apple/apple-enrollment.service';
import { AppleMdmService } from './apple/apple-mdm.service';
import { AppleRawBodyMiddleware } from './apple/apple-raw-body.middleware';
import { MdmController } from './mdm.controller';
import { MdmService } from './mdm.service';
import { MdmSyncService } from './mdm-sync.service';
import { MdmSetupController } from './setup/mdm-setup.controller';
import { MdmSetupService } from './setup/mdm-setup.service';

/** Mobile devices through an MDM provider (0.80 Tablet). The only module that reads a provider (§90). */
@Module({
  // 0.83: Settings → Mobile devices (mdm/setup/, §92), Platform Admin only.
  // 0.84: Rem0te's own Apple MDM server (mdm/apple/, §93).
  controllers: [MdmSetupController, MdmController, AppleDeviceController, AppleAdminController],
  providers: [MdmService, MdmSyncService, MdmSetupService, AppleEnrollmentService, AppleMdmService],
})
export class MdmModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // The device routes' exact bytes, for Mdm-Signature (§93). Nothing else.
    consumer.apply(AppleRawBodyMiddleware).forRoutes(AppleDeviceController);
  }
}
