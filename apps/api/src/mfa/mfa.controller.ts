import { Controller, Get, Post, Delete, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { MfaService } from './mfa.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

class ConfirmTotpDto { @IsString() @Length(6, 6) code!: string; }
class VerifyRecoveryDto { @IsString() code!: string; }

@Controller('mfa')
@UseGuards(JwtAuthGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get('status')
  async status(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.mfa.getTotpStatus(user.sub) };
  }

  @Post('totp/setup')
  async setupTotp(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.mfa.generateTotpSetup(user.sub) };
  }

  @Post('totp/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmTotp(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmTotpDto) {
    return { success: true, data: await this.mfa.confirmTotpEnrollment(user.sub, dto.code) };
  }

  @Post('recovery/verify')
  @HttpCode(HttpStatus.OK)
  async verifyRecovery(@CurrentUser() user: JwtPayload, @Body() dto: VerifyRecoveryDto) {
    const valid = await this.mfa.verifyRecoveryCode(user.sub, dto.code);
    return { success: valid, message: valid ? undefined : 'Invalid recovery code' };
  }

  @Delete('totp')
  @HttpCode(HttpStatus.OK)
  async disableTotp(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmTotpDto) {
    return { success: true, data: await this.mfa.disableTotp(user.sub, dto.code) };
  }
}
