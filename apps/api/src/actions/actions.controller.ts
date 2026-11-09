import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { ActionsService } from './actions.service';

/**
 * Approved actions (v0.26). Requesting, reading, canceling and reconciling an
 * uncertain outcome — there is
 * deliberately no approve route here. Approval happens on the approval
 * signer's own origin, with a passkey on its roster.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class ActionsController {
  constructor(private readonly actions: ActionsService) {}

  @Get('actions/catalog')
  catalog() { return { success: true, data: this.actions.catalog() }; }

  @Get('endpoints/:id/actions')
  async list(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.actions.list(actor, id) };
  }

  @Post('endpoints/:id/actions')
  @RateLimit(10)
  async request(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.actions.request(actor, id, body) };
  }

  @Get('actions/:id')
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.actions.get(actor, id) };
  }

  @Post('actions/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.actions.cancel(actor, id) };
  }

  @Post('actions/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async reconcile(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.actions.reconcile(actor, id, body) };
  }
}
