import { Module } from '@nestjs/common';
import { AiController, AiSettingsController } from './ai.controller';
import { AiSettingsService } from './ai-settings.service';
import { AiService } from './ai.service';

/** AI providers (0.48). The only module that calls a model provider (invariant §41). */
@Module({
  controllers: [AiSettingsController, AiController],
  providers: [AiSettingsService, AiService],
  exports: [AiService],
})
export class AiModule {}
