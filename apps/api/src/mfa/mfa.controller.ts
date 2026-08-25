import { Controller, Get, Post, Delete, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length } from 'class-validator';
import { MfaService } from './mfa.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

class ConfirmTotpDto { @IsString() @Length(6, 6) code!: string; }
class VerifyRecoveryDto { @IsString() @Length(4, 32) code!: string; }

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
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirmTotp(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmTotpDto) {
    return { success: true, data: await this.mfa.confirmTotpEnrollment(user.sub, dto.code) };
  }

  @Post('recovery/verify')
  @HttpCode(HttpStatus.OK)
  // Recovery codes are 40-bit each × 10 issued. Tight throttling defeats brute-force
  // even from a single authenticated session with a live account.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async verifyRecovery(@CurrentUser() user: JwtPayload, @Body() dto: VerifyRecoveryDto) {
    const valid = await this.mfa.verifyRecoveryCode(user.sub, dto.code);
    return { success: valid, message: valid ? undefined : 'Invalid recovery code' };
  }

  @Delete('totp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async disableTotp(@CurrentUser() user: JwtPayload, @Body() dto: ConfirmTotpDto) {
    return { success: true, data: await this.mfa.disableTotp(user.sub, dto.code) };
  }
}
