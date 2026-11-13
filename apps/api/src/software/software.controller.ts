import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { SoftwareService } from './software.service';

/**
 * Software deployment (0.34): the catalog of allowlisted winget packages and
 * deployments of one entry. Every route names its capability:
 *
 *   computers:view   reading the catalog, deployments and a computer's
 *                    managed software; and the deployment routes, whose
 *                    request is then decided per computer by
 *                    AccessPolicyService.evaluateAction (high risk: actions:request,
 *                    or a technician preset allowing higher-risk fixes)
 *   computers:edit   changing the catalog — and the service then requires the
 *                    business's own Business Owner (or a Platform Admin, who
 *                    alone changes global entries) and a fresh sign-in
 *
 * There is no approve or sign route (approval is on the approval signer's own
 * origin), and no upload route: nothing here accepts a file. An installer is
 * downloaded by each computer from winget's source and checked against the
 * pinned SHA-256 there.
 */
@Controller()
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class SoftwareController {
  constructor(private readonly svc: SoftwareService, private readonly stepUp: StepUpService) {}

  private fresh(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get('software/catalog')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId?: string, @Query('archived') archived?: string) {
    return { success: true, data: await this.svc.list(actor, businessId, archived === '1') };
  }

  @Post('software/catalog')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  async create(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.create(actor, body, this.fresh(req)) };
  }

  /** Read a package's installer manifest from winget-pkgs (a bounded GET, no credentials), to pin its hash. */
  @Post('software/manifest-preview')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  async preview(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.previewManifest(actor, body) };
  }

  @Get('software/catalog/:id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.get(actor, id) };
  }

  @Post('software/catalog/:id')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  async update(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.update(actor, id, body, this.fresh(req)) };
  }

  @Post('software/catalog/:id/archive')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  async archive(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.archive(actor, id, body, this.fresh(req)) };
  }

  @Get('software/deployments')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async deployments(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.listDeployments(actor, businessId) };
  }

  /** Bulk: a canary and rings. Each ring is requested separately and approved on the signer. */
  @Post('software/deployments')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async createDeployment(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.createDeployment(actor, body) };
  }

  @Get('software/deployments/:id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async deployment(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.detail(actor, id) };
  }

  @Post('software/deployments/:id/rings/:ring/request')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async requestRing(@Actor() actor: ActorContext, @Param('id') id: string, @Param('ring') ring: string, @Body() body: unknown, @Req() req: Request) {
    if (!/^[0-9]$/.test(ring)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'ring is 0 to 9' });
    return { success: true, data: await this.svc.requestRing(actor, id, Number(ring), body, this.fresh(req)) };
  }

  @Post('software/deployments/:id/pause')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async pause(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.svc.setStatus(actor, id, 'pause', body) };
  }

  @Post('software/deployments/:id/resume')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async resume(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.svc.setStatus(actor, id, 'resume', body) };
  }

  @Post('software/deployments/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async cancel(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.svc.setStatus(actor, id, 'cancel', body) };
  }

  /** The catalog as one computer sees it: detection state, last run, and whether Install / Uninstall is possible. */
  @Get('endpoints/:id/software/catalog')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async endpoint(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.endpointSoftware(actor, id) };
  }

  /** One computer: a one-ring deployment whose plan awaits two approvals on the signer. */
  @Post('endpoints/:id/software/:entryId/:operation')
  @HttpCode(HttpStatus.CREATED)
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async single(@Actor() actor: ActorContext, @Param('id') id: string, @Param('entryId') entryId: string, @Param('operation') operation: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.single(actor, id, entryId, operation, body, this.fresh(req)) };
  }
}
