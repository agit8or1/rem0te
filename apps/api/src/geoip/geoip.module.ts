import { Global, Module } from '@nestjs/common';
import { GeoipService } from './geoip.service';

// Global: the dashboard map needs it today and endpoint detail is the obvious
// next consumer; threading an import through each module adds nothing.
@Global()
@Module({
  providers: [GeoipService],
  exports: [GeoipService],
})
export class GeoipModule {}
