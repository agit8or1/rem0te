import { Global, Module } from '@nestjs/common';
import { SessionEventsService } from './session-events.service';

/**
 * Global: the launcher, the Connect script route, the device heartbeat and
 * Quick Connect all report session evidence, and every one of them must go
 * through the same state machine.
 */
@Global()
@Module({
  providers: [SessionEventsService],
  exports: [SessionEventsService],
})
export class SessionEventsModule {}
