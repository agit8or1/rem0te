import { Controller, Get, Post, Res, UseGuards, ForbiddenException } from '@nestjs/common';
import { Response } from 'express';
import { UpdateService } from './update.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('admin/update')
@UseGuards(JwtAuthGuard)
export class UpdateController {
  constructor(private readonly updateService: UpdateService) {}

  @Get('version')
  getVersion(@CurrentUser() user: JwtPayload) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin required');
    return {
      success: true,
      data: { version: this.updateService.getCurrentVersion() },
    };
  }

  @Get('check')
  async checkUpdate(@CurrentUser() user: JwtPayload) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin required');
    const info = await this.updateService.checkForUpdate();
    return { success: true, data: info };
  }

  @Get('changelog')
  async getChangelog(@CurrentUser() user: JwtPayload) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin required');
    const releases = await this.updateService.getChangelog();
    return { success: true, data: releases };
  }

  /** SSE stream — emits UpdateProgress events during an active update */
  @Get('progress')
  streamProgress(@CurrentUser() user: JwtPayload, @Res() res: Response) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin required');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const subject = this.updateService.applyUpdate();
    const sub = subject.subscribe({
      next: (progress) => {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
      },
      error: (err) => {
        res.write(`data: ${JSON.stringify({ step: 'error', message: err.message, percent: 0, error: err.message, done: true })}\n\n`);
        res.end();
      },
      complete: () => res.end(),
    });

    res.on('close', () => sub.unsubscribe());
  }
}
