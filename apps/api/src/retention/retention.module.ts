import { Module } from '@nestjs/common';
import { RetentionService } from './retention.service';
import { RetentionController } from './retention.controller';

@Module({
  controllers: [RetentionController],
  providers: [RetentionService],
  exports: [RetentionService],
})
export class RetentionModule {}
