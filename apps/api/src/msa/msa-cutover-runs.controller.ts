import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { MsaCutoverRunService } from './msa-cutover-runs.service';

/**
 * Managed Secure Access cutover runs (0.73, build step 5): a device group or
 * a business, canary first, a batch per advance, never the fleet and never
 * by itself. Behind MSA_GRANTS (MsaGrantsGate). Platform Admin only.
 *
 *   - start, advance and confirm need a fresh confirmation (msa.cutover);
 *   - halt and rollback never do: they only reduce.
 */
@Controller('msa/cutover-runs')
@UseGuards(JwtAuthGuard, CapabilitiesGuard, PlatformAdminGuard)
export class MsaCutoverRunsController {
  constructor(private readonly runs: MsaCutoverRunService, private readonly stepUp: StepUpService) {}

  private method(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get()
  async list(@Actor() a: ActorContext) {
    return { success: true, data: await this.runs.list(a) };
  }

  @Get(':runId')
  async view(@Actor() a: ActorContext, @Param('runId') runId: string) {
    return { success: true, data: await this.runs.view(a, runId) };
  }

  /** Start a run: a business or one of its device groups. A fresh confirmation (msa.cutover). */
  @Post()
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async start(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    assertFresh(this.method(req), { action: 'msa.cutover', message: 'Confirm it is you to start a Managed Secure Access cutover run.' });
    return { success: true, data: await this.runs.start(a, body) };
  }

  /** Move the next batch. A fresh confirmation (msa.cutover). */
  @Post(':runId/advance')
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async advance(@Actor() a: ActorContext, @Param('runId') runId: string, @Req() req: Request) {
    assertFresh(this.method(req), { action: 'msa.cutover', message: 'Confirm it is you to move the next batch into Managed Secure Access.' });
    return { success: true, data: await this.runs.advance(a, runId) };
  }

  /** Confirm the moved computers that read back. A fresh confirmation (msa.cutover). */
  @Post(':runId/confirm')
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async confirm(@Actor() a: ActorContext, @Param('runId') runId: string, @Req() req: Request) {
    assertFresh(this.method(req), { action: 'msa.cutover', message: 'Confirm it is you to mark these devices managed and verified.' });
    return { success: true, data: await this.runs.confirm(a, runId) };
  }

  /** Stop the run. Never asks. */
  @Post(':runId/halt')
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async halt(@Actor() a: ActorContext, @Param('runId') runId: string) {
    return { success: true, data: await this.runs.halt(a, runId) };
  }

  /** Roll back every computer the run moved. Never asks. */
  @Post(':runId/rollback')
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async rollback(@Actor() a: ActorContext, @Param('runId') runId: string) {
    return { success: true, data: await this.runs.rollback(a, runId) };
  }
}
