import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { PasskeysService } from './passkeys.service';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/throttling';
import { StepUpService } from '../auth/step-up.service';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import { setAccessCookie, setPartialCookie } from '../auth/cookies';

class RegisterDto {
  @IsObject() response!: RegistrationResponseJSON;
  @IsOptional() @IsString() @MaxLength(60) name?: string;
}
class AssertDto {
  @IsObject() response!: AuthenticationResponseJSON;
}

@Controller('auth')
export class PasskeysController {
  constructor(private readonly svc: PasskeysService, private readonly stepUp: StepUpService) {}

  @Get('passkeys')
  async list(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.svc.list(user.sub) };
  }

  @Post('passkeys/register/options')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async registerOptions(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    await this.stepUp.assert(req, 'passkey.manage');
    return { success: true, data: await this.svc.registrationOptions(user.sub) };
  }

  @Post('passkeys/register')
  @RateLimit(10)
  async register(@CurrentUser() user: JwtPayload, @Body() dto: RegisterDto, @Req() req: Request) {
    await this.stepUp.assert(req, 'passkey.manage');
    return { success: true, data: await this.svc.register(user.sub, dto.response, dto.name, req.ip) };
  }

  @Delete('passkeys/:id')
  async remove(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Req() req: Request) {
    await this.stepUp.assert(req, 'passkey.manage');
    return { success: true, data: await this.svc.remove(user.sub, id, req.ip) };
  }

  @Public()
  @Post('passkeys/login/options')
  @HttpCode(HttpStatus.OK)
  @RateLimit(20)
  async loginOptions() {
    return { success: true, data: await this.svc.loginOptions() };
  }

  @Public()
  @Post('passkeys/login')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async login(@Body() dto: AssertDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.svc.login(dto.response, req.ip ?? 'unknown', req.headers['user-agent'] ?? '');
    // A user-verified passkey satisfies MFA, so this is always a full session;
    // the partial branch is kept so a future policy change cannot strand it.
    if ('accessToken' in result && result.accessToken) setAccessCookie(res, result.accessToken);
    else if ('partialToken' in result && result.partialToken) setPartialCookie(res, result.partialToken);
    return { success: true, data: { requiresMfa: !!result.requiresMfa, user: 'user' in result ? result.user : undefined } };
  }

  @Post('step-up/passkey/options')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async stepUpOptions(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.svc.stepUpOptions(user.sub) };
  }

  @Post('step-up/passkey')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async stepUpVerify(@CurrentUser() user: JwtPayload, @Body() dto: AssertDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const method = await this.svc.stepUp(user.sub, dto.response, req.ip);
    const expiresAt = this.stepUp.issue(res, user.sub, user.iat, method);
    return { success: true, data: { expiresAt, method } };
  }
}
