import { Global, Module } from '@nestjs/common';
import { PlatformSettingsService } from './platform-settings.service';

@Global()
@Module({
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformModule {}
