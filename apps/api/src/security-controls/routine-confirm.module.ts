import { Module } from '@nestjs/common';
import { RoutineConfirmService } from './routine-confirm';
import { RoutineConfirmController } from './routine-confirm.controller';

@Module({
  providers: [RoutineConfirmService],
  controllers: [RoutineConfirmController],
  exports: [RoutineConfirmService],
})
export class RoutineConfirmModule {}
