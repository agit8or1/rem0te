import {
  Controller, Post, Get, Patch, Param, Body, Req,
  UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { LauncherService } from './launcher.service';
import { IssueLauncherTokenDto } from './dto/launcher.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

@Controller('launcher')
export class LauncherController {
  constructor(private readonly launcher: LauncherService) {}

  @Post('token')
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  async issueToken(@Actor() actor: ActorContext, @Body() dto: IssueLauncherTokenDto) {
    const result = await this.launcher.issueToken(actor, dto);
    return { success: true, data: result };
  }

  @Get('validate')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
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
  @UseGuards(JwtAuthGuard, CapabilitiesGuard)
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  @HttpCode(HttpStatus.OK)
  async revokeToken(@Actor() actor: ActorContext, @Param('id') id: string) {
    const result = await this.launcher.revokeToken(actor, id);
    return { success: true, data: result };
  }
}
