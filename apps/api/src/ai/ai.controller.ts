import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Actor } from '../common/decorators/actor.decorator';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { AiSettingsService } from './ai-settings.service';
import { AiService } from './ai.service';

/**
 * Settings → AI (0.48). Platform Admin only (the guard, before anything is
 * read). Saving needs fresh authentication, always: it is not one of the
 * everyday ROUTINE_ACTIONS, because it holds a provider key and decides where
 * redacted event text goes.
 */
@Controller('ai/settings')
@UseGuards(PlatformAdminGuard)
export class AiSettingsController {
  constructor(private readonly settings: AiSettingsService, private readonly stepUp: StepUpService) {}

  @Get()
  async get() { return { success: true, data: await this.settings.get() }; }

  @Put()
  @RateLimit(20)
  async put(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'ai.settings', message: 'Confirm it is you to change the AI provider or its key.' });
    return { success: true, data: await this.settings.put(a, body) };
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RateLimit(5)
  async test(@Actor() a: ActorContext) { return { success: true, data: await this.settings.test(a) }; }
}

/** Ask AI (0.48): availability for everyone signed in, and asking about one entry on one computer. */
@Controller()
export class AiController {
  constructor(private readonly ai: AiService, private readonly settings: AiSettingsService) {}

  /** Whether Ask AI is available, and the provider and model. Never the key or the base URL. */
  @Get('ai/status')
  async status() { return { success: true, data: await this.settings.status() }; }

  @Post('endpoints/:id/ai/explain')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async explain(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.ai.ask(a, id, body) };
  }

  /** Exactly what would be sent, redacted. Sends nothing. */
  @Post('endpoints/:id/ai/preview')
  @HttpCode(HttpStatus.OK)
  @RateLimit(30)
  async preview(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.ai.preview(a, id, body) };
  }
}
