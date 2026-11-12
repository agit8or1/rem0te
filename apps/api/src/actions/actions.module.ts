import { Global, Module } from '@nestjs/common';
import { ActionsController } from './actions.controller';
import { ActionsService } from './actions.service';
import { SignerClient } from './signer.client';
import { RevocationRelay, RevocationRelayController } from './revocations.controller';

// Global: the enrollment heartbeat delivers envelopes and records results.
@Global()
@Module({
  controllers: [ActionsController, RevocationRelayController],
  providers: [ActionsService, SignerClient, RevocationRelay],
  exports: [ActionsService, SignerClient, RevocationRelay],
})
export class ActionsModule {}
