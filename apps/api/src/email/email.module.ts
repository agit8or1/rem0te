import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { EmailRecipientsController, SmtpSettingsController } from './email.controller';

// Global: monitoring (alert emails) and reports (schedules) send through it.
@Global()
@Module({
  controllers: [SmtpSettingsController, EmailRecipientsController],
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
