import { Module } from '@nestjs/common';
import { DeviceControlController } from './device-control.controller';
import { DeviceControlService } from './device-control.service';

/** Service control and End process (0.45). ActionsService and SignerClient come from the global ActionsModule. */
@Module({
  controllers: [DeviceControlController],
  providers: [DeviceControlService],
})
export class DeviceControlModule {}
