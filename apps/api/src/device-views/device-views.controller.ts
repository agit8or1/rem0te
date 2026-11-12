import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StepUpService } from '../auth/step-up.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { SavedViewsService } from './saved-views.service';
import { DeviceGroupsService } from './device-groups.service';
import { DeviceBulkService } from './device-bulk.service';

const biz = (q: Record<string, unknown>) => (typeof q.businessId === 'string' && q.businessId ? q.businessId : undefined);

/**
 * Saved device-list views (0.33). There is no route that runs a view: the
 * browser opens one with GET /endpoints/list, as the viewer.
 */
@Controller('device-views')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class DeviceViewsController {
  constructor(private readonly svc: SavedViewsService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() a: ActorContext) {
    return { success: true, data: await this.svc.list(a) };
  }

  @Get(':id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async get(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.get(a, id) };
  }

  @Post()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  async create(@Actor() a: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.create(a, body) };
  }

  @Patch(':id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  async update(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.svc.update(a, id, body) };
  }

  @Delete(':id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  async remove(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.remove(a, id) };
  }
}

/** Static device groups (0.33). Writes need manageRefusal() over the group's business, checked in the service. */
@Controller('device-groups')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class DeviceGroupsController {
  constructor(private readonly svc: DeviceGroupsService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.svc.list(a, biz(q)) };
  }

  @Post()
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(30)
  async create(@Actor() a: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.create(a, body) };
  }

  @Patch(':id')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(30)
  async update(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.svc.update(a, id, body) };
  }

  @Delete(':id')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(30)
  async remove(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.remove(a, id) };
  }
}

/**
 * Bulk actions on selected computers (0.33): at most BULK_MAX per request,
 * each computer decided on its own with the single action's checks. The
 * route gate is computers:view (refreshing inventory needs no more); each
 * action asks for what it needs per computer and says why when it refuses.
 */
@Controller('endpoints/bulk')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class DeviceBulkController {
  constructor(private readonly svc: DeviceBulkService, private readonly stepUp: StepUpService) {}

  @Post()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async run(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    // The fresh-sign-in method, for agent.migrate (0.34); asked by that action only.
    const u = req.user as { sub?: string; iat?: number } | undefined;
    const fresh = u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
    return { success: true, data: await this.svc.run(a, body, fresh) };
  }

  /** The selected computers as CSV — the device list's export, audited (ENDPOINT_LIST_EXPORTED) before it is sent. */
  @Post('export.csv')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async export(@Actor() a: ActorContext, @Body() body: unknown, @Res() res: Response) {
    const out = await this.svc.exportSelection(a, body);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Rows', String(out.rows));
    res.setHeader('X-Not-Exported', String(out.notExported));
    res.send(out.csv);
  }
}
