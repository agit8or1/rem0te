import {
  Controller, Post, Get, Patch, Param, Body, Req,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import { LauncherService } from './launcher.service';
import { IssueLauncherTokenDto } from './dto/launcher.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('launcher')
export class LauncherController {
  constructor(private readonly launcher: LauncherService) {}

  @Post('token')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('sessions:create')
  async issueToken(
    @CurrentUser() user: JwtPayload,
    @Body() dto: IssueLauncherTokenDto,
    @Req() req: Request,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const ip = req.ip ?? req.socket?.remoteAddress;
    const result = await this.launcher.issueToken(user.tenantId, user.sub, dto, ip);
    return { success: true, data: result };
  }

  @Get('validate')
  @Public()
  @HttpCode(HttpStatus.OK)
  async validateToken(@Req() req: Request) {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (req.query['token'] as string | undefined);

    if (!token) {
      return { success: false, message: 'No token provided' };
    }

    const ip = req.ip ?? req.socket?.remoteAddress;
    const result = await this.launcher.validateToken(token, ip);
    return { success: true, data: result };
  }

  @Patch('token/:id/revoke')
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @RequirePermissions('sessions:update')
  @HttpCode(HttpStatus.OK)
  async revokeToken(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const result = await this.launcher.revokeToken(user.tenantId, id, user.sub);
    return { success: true, data: result };
  }
}
