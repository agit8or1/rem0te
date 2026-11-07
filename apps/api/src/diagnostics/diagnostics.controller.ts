import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsObject, IsOptional, IsString, Length } from 'class-validator';
import { DiagnosticsService } from './diagnostics.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { PrismaService } from '../prisma/prisma.service';

export class TechnicianReportDto {
  @IsString()
  @Length(48, 48)
  token!: string;

  @IsOptional()
  @IsObject()
  report?: Record<string, unknown>;
}

/**
 * Test Connection.
 *
 * Read-only by construction: every route here reports, none changes
 * configuration or starts a session. Repairs the panel offers are the
 * existing routes (accept device secret, reinstall agent, rotate credential,
 * the RustDesk setup script), each behind its own authorization.
 */
@Controller()
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class DiagnosticsController {
  constructor(
    private readonly svc: DiagnosticsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('endpoints/:id/diagnostics')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async run(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.run(actor, id) };
  }

  /** Redacted plain-text report to attach to a ticket or send to support. */
  @Get('endpoints/:id/diagnostics/report')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async report(@Actor() actor: ActorContext, @Param('id') id: string, @Res() res: Response) {
    const text = await this.svc.report(actor, id);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rem0te-diagnostics-${stamp}.txt"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(text);
  }

  /**
   * The read-only helper a technician runs on their own Windows computer. It
   * carries a single-use, two-hour token naming this user, and reports back
   * to /diagnostics/technician/report.
   */
  @Get('diagnostics/technician/helper.cmd')
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  async helper(@Actor() actor: ActorContext, @Query('endpointId') endpointId: string | undefined, @Res() res: Response) {
    const cmd = await this.svc.technicianHelper(actor, endpointId || undefined);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="rem0te-check-my-computer.cmd"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(cmd);
  }

  /** Posted by the helper. The token is the only credential; it is single use. */
  @Post('diagnostics/technician/report')
  @Public()
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async submit(@Body() dto: TechnicianReportDto, @Req() req: Request) {
    const r = await this.svc.submitTechnicianReport(dto.token, dto.report ?? {}, req.ip);
    return { success: r.accepted };
  }

  /** The caller's own latest helper report, for polling after running it. */
  @Get('diagnostics/technician/latest')
  @RequireCapability(CAP.COMPUTERS_CONNECT)
  async latest(@Actor() actor: ActorContext) {
    const last = await this.prisma.technicianDiagnostic.findFirst({
      where: { userId: actor.userId, submittedAt: { not: null } },
      orderBy: { submittedAt: 'desc' },
      select: { submittedAt: true, report: true },
    });
    return { success: true, data: last };
  }
}
