import { Global, Module } from '@nestjs/common';
import { UpdateMirrorController, UpdateTrustController } from './update-trust.controller';
import { UpdateTrustService } from './update-trust.service';

@Global()
@Module({
  controllers: [UpdateMirrorController, UpdateTrustController],
  providers: [UpdateTrustService],
  exports: [UpdateTrustService],
})
export class UpdateTrustModule {}
