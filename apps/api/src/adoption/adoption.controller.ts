import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { AdoptionService } from './adoption.service';
import { DeploymentKeysService } from './deployment-keys.service';

/**
 * Discovery and adoption (0.57). Every route is a Platform Admin's: the
 * services assert it first. The fresh sign-in is read here and checked in the
 * service after every input check (devices.adopt, deployment.keys,
 * adoption.mappings).
 */
@Controller('adoption')
@UseGuards(JwtAuthGuard)
export class AdoptionController {
  constructor(
    private readonly adoption: AdoptionService,
    private readonly keys: DeploymentKeysService,
    private readonly stepUp: StepUpService,
  ) {}

  private fresh(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  // ── The pool ──────────────────────────────────────────────────────────────

  @Get('devices')
  async list(@Actor() actor: ActorContext) {
    return { success: true, data: await this.adoption.list(actor) };
  }

  @Post('devices/assign')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async assign(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.adoption.adopt(actor, body, this.fresh(req)) };
  }

  @Post('devices/forget')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async forget(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.adoption.forget(actor, body, this.fresh(req)) };
  }

  // ── Assignment rules ──────────────────────────────────────────────────────

  @Get('mappings')
  async mappings(@Actor() actor: ActorContext) {
    return { success: true, data: await this.adoption.listMappings(actor) };
  }

  @Post('mappings')
  @RateLimit(20)
  async createMapping(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.adoption.createMapping(actor, body, this.fresh(req)) };
  }

  @Delete('mappings/:id')
  @HttpCode(HttpStatus.OK)
  async deleteMapping(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.adoption.deleteMapping(actor, id) };
  }

  // ── Deployment keys ───────────────────────────────────────────────────────

  @Get('deployment-keys')
  async listKeys(@Actor() actor: ActorContext) {
    return { success: true, data: await this.keys.list(actor) };
  }

  @Post('deployment-keys')
  @RateLimit(10)
  async createKey(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.keys.create(actor, body, this.fresh(req)) };
  }

  @Post('deployment-keys/:id/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeKey(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.keys.revoke(actor, id) };
  }
}
