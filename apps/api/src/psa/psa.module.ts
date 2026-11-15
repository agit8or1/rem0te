import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { PsaConnectorsController, PsaTicketsController } from './psa.controller';
import { PsaService } from './psa.service';

/** PSA tickets (0.48): connectors and "Create ticket". */
@Module({
  imports: [AiModule],
  controllers: [PsaConnectorsController, PsaTicketsController],
  providers: [PsaService],
  // 0.51: the tray's support request becomes a ticket through PsaService.
  exports: [PsaService],
})
export class PsaModule {}
