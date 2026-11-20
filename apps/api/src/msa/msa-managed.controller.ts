import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { MsaManagedService } from './msa-managed.service';
import { MsaGrantService } from './msa-grant.service';

/**
 * Managed Secure Access cutover, the managed test session and rollback
 * (0.72, build step 4), console side. Behind MSA_GRANTS (MsaGrantsGate runs
 * before anything else). Every change is a Platform Admin's, for ONE
 * computer: there is no route for a group, a business or the fleet.
 *
 *   - cutover and confirm need a fresh confirmation (msa.cutover);
 *   - revealing the one-time password needs one (msa.reveal), once;
 *   - rollback never does: it only reduces.
 */
@Controller('msa/managed')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class MsaManagedController {
  constructor(private readonly managed: MsaManagedService, private readonly grants: MsaGrantService, private readonly stepUp: StepUpService) {}

  private method(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  /** The device card's managed view. View computers, in scope. */
  @Get(':endpointId')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async view(@Actor() a: ActorContext, @Param('endpointId') endpointId: string) {
    return { success: true, data: await this.managed.view(a, endpointId) };
  }

  /** Move ONE computer into Managed (pending). Platform Admin, a fresh confirmation (msa.cutover). */
  @Post(':endpointId/cutover')
  @UseGuards(PlatformAdminGuard)
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async cutover(@Actor() a: ActorContext, @Param('endpointId') endpointId: string, @Req() req: Request) {
    assertFresh(this.method(req), { action: 'msa.cutover', message: 'Confirm it is you to move this computer into Managed Secure Access.' });
    return { success: true, data: await this.managed.cutover(a, endpointId) };
  }

  /** Confirm a Managed (pending) computer verified after its test session. Platform Admin, a fresh confirmation (msa.cutover). */
  @Post(':endpointId/confirm')
  @UseGuards(PlatformAdminGuard)
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async confirm(@Actor() a: ActorContext, @Param('endpointId') endpointId: string, @Req() req: Request) {
    assertFresh(this.method(req), { action: 'msa.cutover', message: 'Confirm it is you to mark this computer managed and verified.' });
    return { success: true, data: await this.managed.confirm(a, endpointId) };
  }

  /** Roll ONE computer back to Legacy. Platform Admin; never a fresh confirmation (it only reduces). */
  @Post(':endpointId/rollback')
  @UseGuards(PlatformAdminGuard)
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async rollback(@Actor() a: ActorContext, @Param('endpointId') endpointId: string, @Body() body: { force?: unknown } | undefined) {
    return { success: true, data: await this.managed.rollback(a, endpointId, body?.force === true) };
  }

  /** Show a managed test grant's one-time password, once. Platform Admin, a fresh confirmation (msa.reveal). */
  @Post('grants/:grantId/reveal')
  @UseGuards(PlatformAdminGuard)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async reveal(@Actor() a: ActorContext, @Param('grantId') grantId: string, @Req() req: Request) {
    assertFresh(this.method(req), { action: 'msa.reveal', message: 'Confirm it is you to see the one-time password.' });
    return { success: true, data: await this.grants.reveal(a, grantId) };
  }
}
