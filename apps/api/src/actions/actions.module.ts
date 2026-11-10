import { Global, Module } from '@nestjs/common';
import { ActionsController } from './actions.controller';
import { ActionsService } from './actions.service';
import { SignerClient } from './signer.client';

// Global: the enrollment heartbeat delivers envelopes and records results.
@Global()
@Module({
  controllers: [ActionsController],
  providers: [ActionsService, SignerClient],
  exports: [ActionsService, SignerClient],
})
export class ActionsModule {}
