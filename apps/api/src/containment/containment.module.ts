import { Global, Module } from '@nestjs/common';
import { ContainmentController } from './containment.controller';
import { ContainmentService } from './containment.service';

// Global: the launch policy, the action dispatcher, the heartbeat and the
// integration API all ask it before writing.
@Global()
@Module({ controllers: [ContainmentController], providers: [ContainmentService], exports: [ContainmentService] })
export class ContainmentModule {}
