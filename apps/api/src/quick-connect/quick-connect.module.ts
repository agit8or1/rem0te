import { Module } from '@nestjs/common';
import { QuickConnectController } from './quick-connect.controller';
import { QuickConnectPublicController } from './quick-connect-public.controller';
import { QuickConnectService } from './quick-connect.service';

@Module({
  controllers: [QuickConnectController, QuickConnectPublicController],
  providers: [QuickConnectService],
  exports: [QuickConnectService],
})
export class QuickConnectModule {}
