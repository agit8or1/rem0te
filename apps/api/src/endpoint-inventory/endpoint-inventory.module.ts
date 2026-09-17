import { Module } from '@nestjs/common';
import { EndpointInventoryService } from './endpoint-inventory.service';

// Shared by two modules that must not import each other: the enrollment
// heartbeat writes what an endpoint reports, and the endpoints API reads it
// back and stages what to collect next.
@Module({
  providers: [EndpointInventoryService],
  exports: [EndpointInventoryService],
})
export class EndpointInventoryModule {}
