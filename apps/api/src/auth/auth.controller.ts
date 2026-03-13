import {
  Controller, Post, Get, Patch, Body, Req, Res,
  HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, VerifyMfaDto, SwitchTenantDto } from './dto/login.dto';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from './strategies/jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? 'unknown';
    const userAgent = req.headers['user-agent'] ?? '';
    const result = await this.authService.login(dto, ip, userAgent);

    if (!result.requiresMfa && 'accessToken' in result && result.accessToken) {
      this.setAuthCookie(res, result.accessToken);
    } else if (result.requiresMfa && 'partialToken' in result && result.partialToken) {
      // Store partial token in httpOnly cookie so MFA page can access it without exposing to JS
      res.cookie('partial_token', result.partialToken, {
        httpOnly: true,
        secure: process.env.COOKIE_SECURE === 'true',
        sameSite: 'lax',
        maxAge: 10 * 60 * 1000, // 10 minutes
        path: '/',
      });
    }

    return { success: true, data: result };
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? 'unknown';
    // Prefer httpOnly cookie over body — prevents token fixation via body injection
    const cookieToken = (req.cookies as Record<string, string>)?.['partial_token'];
    const partialToken = cookieToken ?? dto.partialToken;
    if (!partialToken) {
      return { success: false, message: 'No partial token found' };
    }
    const result = await this.authService.verifyMfaAndLogin(partialToken, dto.code, ip);
    res.clearCookie('partial_token');
    this.setAuthCookie(res, result.accessToken);
    return { success: true, data: result };
  }

  @UseGuards(JwtAuthGuard)
  @Post('switch-tenant')
  @HttpCode(HttpStatus.OK)
  async switchTenant(
    @Body() dto: SwitchTenantDto,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = await this.authService.switchTenant(user.sub, dto.tenantSlug);
    this.setAuthCookie(res, token);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return { success: true, data: user };
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async profile(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.authService.getProfile(user.sub) };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() body: { firstName?: string; lastName?: string; email?: string },
  ) {
    return { success: true, data: await this.authService.updateProfile(user.sub, body) };
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return { success: true, data: await this.authService.changePassword(user.sub, body.currentPassword, body.newPassword) };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie('access_token');
    return { success: true };
  }

  private setAuthCookie(res: Response, token: string) {
    res.cookie('access_token', token, {
      httpOnly: true,
      secure: process.env.COOKIE_SECURE === 'true',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/',
    });
  }
}
