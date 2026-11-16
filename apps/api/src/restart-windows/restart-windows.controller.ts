import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { RestartWindowsService } from './restart-windows.service';

/**
 * Restart windows (0.60): a business's, a device group's and a computer's.
 * Reading needs the scope and computers:view. Writing is decided in the
 * service: who may (a Business Owner, a whole-business technician with
 * computers:edit and actions:request, or the MSP; a computer's own setting
 * needs computers:edit and actions:request on it), and when a fresh sign-in
 * is needed (restart.window: anything that can restart a computer where it
 * would not have before — never "no automatic restarts", never removing a
 * business's window). There is no approve route: a window is approved on
 * the approval signer, with passkeys, like any automation policy.
 */
@Controller('restart-windows')
@UseGuards(JwtAuthGuard)
export class RestartWindowsController {
  constructor(private readonly svc: RestartWindowsService, private readonly stepUp: StepUpService) {}

  private freshMethod(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get('businesses/:businessId')
  async business(@Actor() actor: ActorContext, @Param('businessId') businessId: string) {
    return { success: true, data: await this.svc.forBusiness(actor, businessId) };
  }

  @Put('businesses/:businessId')
  @RateLimit(20)
  async setBusiness(@Actor() actor: ActorContext, @Param('businessId') businessId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.setBusiness(actor, businessId, body, this.freshMethod(req)) };
  }

  @Delete('businesses/:businessId')
  async clearBusiness(@Actor() actor: ActorContext, @Param('businessId') businessId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.clearBusiness(actor, businessId, body, this.freshMethod(req)) };
  }

  @Put('businesses/:businessId/groups/:groupId')
  @RateLimit(20)
  async setGroup(@Actor() actor: ActorContext, @Param('businessId') businessId: string, @Param('groupId') groupId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.setGroup(actor, businessId, groupId, body, this.freshMethod(req)) };
  }

  @Delete('businesses/:businessId/groups/:groupId')
  async clearGroup(@Actor() actor: ActorContext, @Param('businessId') businessId: string, @Param('groupId') groupId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.clearGroup(actor, businessId, groupId, body, this.freshMethod(req)) };
  }

  @Get('computers/:endpointId')
  async computer(@Actor() actor: ActorContext, @Param('endpointId') endpointId: string) {
    return { success: true, data: await this.svc.forComputer(actor, endpointId) };
  }

  @Put('computers/:endpointId')
  @RateLimit(20)
  async setComputer(@Actor() actor: ActorContext, @Param('endpointId') endpointId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.setComputer(actor, endpointId, body, this.freshMethod(req)) };
  }

  @Delete('computers/:endpointId')
  async clearComputer(@Actor() actor: ActorContext, @Param('endpointId') endpointId: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.clearComputer(actor, endpointId, body, this.freshMethod(req)) };
  }

  /** The device list's "Set restart window…": no automatic restarts, or inherit, for a selection (at most 200). */
  @Post('computers/bulk')
  @HttpCode(HttpStatus.OK)
  @RateLimit(5)
  async bulk(@Actor() actor: ActorContext, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.svc.bulk(actor, body, this.freshMethod(req)) };
  }
}
