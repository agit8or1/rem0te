import { Module } from '@nestjs/common';
import { ConfirmPolicyService } from './confirm-policy.service';
import { ConfirmPolicyController } from './confirm-policy.controller';

@Module({
  providers: [ConfirmPolicyService],
  controllers: [ConfirmPolicyController],
  exports: [ConfirmPolicyService],
})
export class ConfirmPolicyModule {}
