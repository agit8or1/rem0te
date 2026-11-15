import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { TasksService } from './tasks.service';

/**
 * Task progress (0.52): three reads, no writes. Cancelling a scheduled task
 * is the existing POST /actions/:id/cancel, which touches only a plan that
 * has reached no computer.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('tasks')
  async list(@Actor() actor: ActorContext, @Query('state') state?: string, @Query('type') type?: string, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.tasks.list(actor, { state, type, businessId }) };
  }

  /** The toast poll: what I started that finished since `since`. */
  @Get('tasks/mine')
  async mine(@Actor() actor: ActorContext, @Query('since') since?: string) {
    return { success: true, data: await this.tasks.mine(actor, since) };
  }

  @Get('endpoints/:id/tasks')
  async endpoint(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.tasks.forEndpoint(actor, id) };
  }
}
