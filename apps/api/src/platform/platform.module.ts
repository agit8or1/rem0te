import { Global, Module } from '@nestjs/common';
import { PlatformSettingsService } from './platform-settings.service';
import { PublicUrlService } from './public-url.service';
import { AddressProbeController, PublicAddressController } from './public-url.controller';

@Global()
@Module({
  controllers: [PublicAddressController, AddressProbeController],
  providers: [PlatformSettingsService, PublicUrlService],
  exports: [PlatformSettingsService, PublicUrlService],
})
export class PlatformModule {}
