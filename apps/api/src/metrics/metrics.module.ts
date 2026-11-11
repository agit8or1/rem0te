import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

// Global: the heartbeat and the inventory pass record into it.
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
