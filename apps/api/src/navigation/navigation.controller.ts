import { Body, Controller, Delete, Get, Header, Param, Post, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { NavigationService } from './navigation.service';

/**
 * The signed-in person's navigation state (0.87): GET /me/navigation, and
 * the four writes to their own preferences, favourites and recent items.
 * There is no route naming another person, and no capability gate: every
 * signed-in person has a menu. What each item points to is resolved through
 * that record's own visibility rule on every read (NavigationService).
 */
@Controller('me/navigation')
@UseGuards(JwtAuthGuard)
export class NavigationController {
  constructor(private readonly svc: NavigationService) {}

  @Get()
  @RateLimit(60)
  @Header('Cache-Control', 'no-store')
  async view(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.view(actor) };
  }

  @Put('preferences')
  @RateLimit(60)
  async preferences(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.setPreferences(actor, body) };
  }

  @Post('favorites')
  @RateLimit(30)
  async addFavorite(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.addFavorite(actor, body) };
  }

  @Delete('favorites/:id')
  @RateLimit(30)
  async removeFavorite(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.removeFavorite(actor, id) };
  }

  @Post('recent')
  @RateLimit(120)
  async recent(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.recordVisit(actor, body) };
  }
}
