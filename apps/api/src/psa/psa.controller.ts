import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { PsaService } from './psa.service';

function fresh(stepUp: StepUpService, req: Request) {
  const u = req.user as { sub?: string; iat?: number } | undefined;
  // Catalog key psa.connector (§62): a connector decides where tickets — with computer names and log text — are sent.
  assertFresh(u?.sub ? stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'psa.connector', message: 'Confirm it is you to change where tickets are sent.' });
}

const scopeOf = (q: Record<string, unknown>) => ({ scope: q.scope === 'global' ? 'global' as const : 'business' as const, businessId: typeof q.businessId === 'string' && q.businessId ? q.businessId : null });

/**
 * Administration → PSA / ticketing (0.48). The platform default is a Platform
 * Admin's; a business's own connector its Business Owner's (checked in the
 * service). Every write needs fresh authentication.
 */
@Controller('psa/connectors')
export class PsaConnectorsController {
  constructor(private readonly psa: PsaService, private readonly stepUp: StepUpService) {}

  @Get()
  async get(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) {
    const s = scopeOf(q);
    return { success: true, data: await this.psa.getConnector(a, s.scope, s.businessId) };
  }

  @Put()
  @RateLimit(20)
  async put(@Actor() a: ActorContext, @Body() body: unknown, @Req() req: Request) {
    fresh(this.stepUp, req);
    return { success: true, data: await this.psa.putConnector(a, body) };
  }

  @Delete()
  @RateLimit(20)
  async remove(@Actor() a: ActorContext, @Query() q: Record<string, unknown>, @Req() req: Request) {
    fresh(this.stepUp, req);
    const s = scopeOf(q);
    return { success: true, data: await this.psa.removeConnector(a, s.scope, s.businessId) };
  }
}

/** Create ticket (0.48), from one computer's event-log entry or alert. */
@Controller('endpoints/:id/tickets')
export class PsaTicketsController {
  constructor(private readonly psa: PsaService) {}

  @Get()
  async status(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.psa.status(a, id) };
  }

  /** The default subject, and whether an AI explanation is available to include. Sends nothing. */
  @Post('draft')
  @HttpCode(HttpStatus.OK)
  @RateLimit(30)
  async draft(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.psa.draft(a, id, body) };
  }

  @Post()
  @RateLimit(5)
  async create(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.psa.create(a, id, body) };
  }
}
