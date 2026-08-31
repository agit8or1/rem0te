import {
  Controller, Post, Get, Patch, Body, Req, Res,
  HttpCode, HttpStatus, UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, VerifyMfaDto } from './dto/login.dto';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { PrismaService } from '../prisma/prisma.service';
import type { ActorContext } from '../rbac/access-control.service';
import { accessLevelLabel } from '../rbac/capabilities';
import type { JwtPayload } from './strategies/jwt.strategy';
import { RateLimit } from '../common/throttling';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
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
        secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
        sameSite: 'strict',
        maxAge: 10 * 60 * 1000, // 10 minutes
        path: '/',
      });
    }

    return { success: true, data: result };
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
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
  @UseGuards(JwtAuthGuard)
  /**
   * Who am I, and what am I allowed to do.
   *
   * The capability list is the *effective* one — a Business Owner gets the
   * full set even though their membership row stores none — so the UI has a
   * single thing to check and never has to re-derive the role rules. It is
   * for rendering only; the server re-checks everything on every request.
   */
  @Get('me')
  async me(@Actor() actor: ActorContext) {
    const business = actor.businessId
      ? await this.prisma.customer.findUnique({
          where: { id: actor.businessId },
          select: { id: true, name: true, isActive: true, quickConnectEnabled: true },
        })
      : null;

    return {
      success: true,
      data: {
        id: actor.userId,
        email: actor.email,
        isPlatformAdmin: actor.isPlatformAdmin,
        roleType: actor.roleType,
        accessLevel: accessLevelLabel(actor),
        businessId: actor.businessId,
        business,
        capabilities: actor.capabilities,
        tenantId: actor.tenantId,
      },
    };
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
    @Body() body: {
      firstName?: string; lastName?: string; email?: string;
      phone?: string; jobTitle?: string;
      address?: string; city?: string; state?: string; country?: string; postalCode?: string;
      timeZone?: string;
    },
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
      secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000,
      path: '/',
    });
  }
}
