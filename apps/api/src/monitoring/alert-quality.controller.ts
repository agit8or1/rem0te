import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { FalsePositiveService } from './false-positive.service';
import { QualityRulesService } from './quality-rules.service';

/**
 * Alert quality (0.67): false-positive reports, recommendations, the quality
 * dashboard and alert quality rules. Reporting never changes a monitor or a
 * rule. A rule applies only after it was tested against stored history and
 * approved; approving asks the person to confirm it is them
 * (`monitoring.qualityrule`), after every scope and validation check and
 * before the write. Rejecting and rolling back never ask: they only ever
 * bring alerts back.
 */
@Controller('monitoring')
@UseGuards(JwtAuthGuard)
export class AlertQualityController {
  constructor(private readonly fp: FalsePositiveService, private readonly rules: QualityRulesService, private readonly stepUp: StepUpService) {}

  private fresh(req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return () => assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { action: 'monitoring.qualityrule' });
  }

  @Get('alerts/:id/false-positive')
  async fpContext(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.fp.context(a, id) }; }

  @Post('alerts/:id/false-positive')
  @HttpCode(HttpStatus.OK)
  @RateLimit(30)
  async fpReport(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) { return { success: true, data: await this.fp.report(a, id, body) }; }

  @Get('quality/summary')
  async summary(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.fp.summary(a, q) }; }

  @Get('quality/reports')
  async reports(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.fp.reports(a, q) }; }

  @Get('quality/recommendations')
  async recommendations(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.fp.recommendations(a, q) }; }

  @Post('quality/recommendations/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) { return { success: true, data: await this.fp.dismiss(a, id, body) }; }

  @Get('quality/recommendations/:id/preview')
  @RateLimit(20)
  async preview(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.fp.preview(a, id) }; }

  @Get('quality/checks')
  @RateLimit(20)
  async checks(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.fp.checks(a, q) }; }

  @Get('quality/rules')
  async list(@Actor() a: ActorContext, @Query() q: Record<string, unknown>) { return { success: true, data: await this.rules.list(a, q) }; }

  @Post('quality/rules')
  @RateLimit(20)
  async create(@Actor() a: ActorContext, @Body() body: unknown) { return { success: true, data: await this.rules.create(a, body) }; }

  @Get('quality/rules/:id')
  async get(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.rules.get(a, id) }; }

  @Patch('quality/rules/:id')
  async edit(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) { return { success: true, data: await this.rules.edit(a, id, body) }; }

  @Post('quality/rules/:id/simulate')
  @HttpCode(HttpStatus.OK)
  @RateLimit(20)
  async simulate(@Actor() a: ActorContext, @Param('id') id: string) { return { success: true, data: await this.rules.simulate(a, id) }; }

  @Post('quality/rules/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return { success: true, data: await this.rules.approve(a, id, body, this.fresh(req)) };
  }

  @Post('quality/rules/:id/reject')
  @HttpCode(HttpStatus.OK)
  async reject(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) { return { success: true, data: await this.rules.reject(a, id, body) }; }

  @Post('quality/rules/:id/rollback')
  @HttpCode(HttpStatus.OK)
  async rollback(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: unknown) { return { success: true, data: await this.rules.rollback(a, id, body) }; }
}
