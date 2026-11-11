import { Body, Controller, Delete, ForbiddenException, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { ClientUpdatesService, FreshAuthNeeded } from './client-updates.service';

const biz = (q: Record<string, unknown>) => (typeof q.businessId === 'string' && q.businessId ? q.businessId : undefined);

/**
 * Scheduled RustDesk client updates (0.32). See ClientUpdatesService for who
 * may do what. Turning a policy on needs fresh authentication; turning it off
 * does not.
 */
@Controller('client-updates')
@UseGuards(JwtAuthGuard)
export class ClientUpdatesController {
  constructor(private readonly svc: ClientUpdatesService, private readonly stepUp: StepUpService) {}

  private isFresh(req: Request): boolean {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return !!(u?.sub && this.stepUp.read(req, u.sub, u.iat)?.method);
  }

  /**
   * The service decides whether this write needs fresh authentication (only
   * after it has checked the person may make it at all, so a refusal is never
   * disguised as a step-up prompt). This turns its answer into the standard
   * STEP_UP_REQUIRED refusal, which the console answers with its step-up
   * dialog and a retry; the action names what is being confirmed.
   */
  private async fresh<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (e instanceof FreshAuthNeeded) {
        throw new ForbiddenException({
          code: 'STEP_UP_REQUIRED', action: 'updates.schedule',
          message: 'Confirm it is you to continue: turning on automatic client updates lets the server install software on this business’s computers without anyone clicking Update.',
        });
      }
      throw e;
    }
  }

  @Get('policy')
  async policy(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.svc.getPolicy(a, biz(q)) };
  }

  @Put('policy')
  async putPolicy(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.fresh(() => this.svc.putPolicy(a, body, this.isFresh(req))) };
  }

  @Delete('policy/sites/:siteId')
  async deleteOverride(@Actor() a: ActorContext, @Param('siteId') siteId: string, @Query() q: Record<string, unknown>, @Req() req: Request) {
    return { success: true, data: await this.fresh(() => this.svc.deleteSiteOverride(a, biz(q), siteId, this.isFresh(req))) };
  }

  @Get('computers')
  async computers(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.svc.computers(a, biz(q)) };
  }
}
