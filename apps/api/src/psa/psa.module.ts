import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { PsaConnectorsController, PsaTicketsController } from './psa.controller';
import { PsaService } from './psa.service';

/** PSA tickets (0.48): connectors and "Create ticket". */
@Module({
  imports: [AiModule],
  controllers: [PsaConnectorsController, PsaTicketsController],
  providers: [PsaService],
})
export class PsaModule {}
