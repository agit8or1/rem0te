import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { ScriptRunService } from './script-run.service';

/**
 * Running approved library scripts (0.34). Four routes, and deliberately no
 * approve, sign, execute or allowlist-add route: an entry joins the approval
 * signer's allowlist only by two passkey approvals on the signer's origin,
 * and a run is a windows.script.run@1 plan approved there like any other.
 *
 *   GET  /script-runs/versions/:versionId                  readiness — library visibility (scripts:author or scripts:review)
 *   POST /script-runs/versions/:versionId/allowlist        propose to the signer — scripts:review (global: Platform Admin / approvals:review)
 *   POST /script-runs/versions/:versionId/allowlist/revoke revoke, one-way — the same
 *   POST /script-runs                                      request a run — library visibility and actions:request (higher risk) on every computer
 */
@Controller('script-runs')
@UseGuards(JwtAuthGuard)
export class ScriptRunController {
  constructor(private readonly svc: ScriptRunService) {}

  @Get('versions/:versionId')
  async readiness(@Actor() actor: ActorContext, @Param('versionId') versionId: string) {
    return { success: true, data: await this.svc.readiness(actor, versionId) };
  }

  @Post('versions/:versionId/allowlist')
  @RateLimit(10)
  async propose(@Actor() actor: ActorContext, @Param('versionId') versionId: string) {
    return { success: true, data: await this.svc.propose(actor, versionId) };
  }

  @Post('versions/:versionId/allowlist/revoke')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async revoke(@Actor() actor: ActorContext, @Param('versionId') versionId: string, @Body() body: unknown) {
    return { success: true, data: await this.svc.revoke(actor, versionId, body) };
  }

  @Post()
  @RateLimit(10)
  async run(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.requestRun(actor, body) };
  }
}
