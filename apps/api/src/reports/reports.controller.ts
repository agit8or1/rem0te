import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { ReportsService, parseReportQuery, type ReportKey } from './reports.service';

/**
 * Reports (0.32). Each route needs the capability of the data it summarises
 * — computers:view for patch compliance and agent coverage, monitoring:alerts
 * for alert frequency and offline time — and the service scopes every query
 * (see ReportsService). Each CSV is audited as REPORT_EXPORTED before it is sent.
 */
@Controller('reports')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  private async send(res: Response, actor: ActorContext, report: ReportKey, q: Record<string, unknown>) {
    const out = await this.reports.exportCsv(actor, report, parseReportQuery(q));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Rows', String(out.rows));
    res.send(out.csv);
  }

  /** Patch compliance per business and site, from stored Windows Update scans — the dashboard's definition. */
  @Get('patch-compliance')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async patchCompliance(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.reports.patchCompliance(actor, parseReportQuery(q)) };
  }

  @Get('patch-compliance/export.csv')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async patchComplianceCsv(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>, @Res() res: Response) {
    await this.send(res, actor, 'patch-compliance', q);
  }

  /** Agent types and versions, device secrets, silent computers, non-Windows computers without inventory. */
  @Get('agent-coverage')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async agentCoverage(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.reports.agentCoverage(actor, parseReportQuery(q)) };
  }

  @Get('agent-coverage/export.csv')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async agentCoverageCsv(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>, @Res() res: Response) {
    await this.send(res, actor, 'agent-coverage', q);
  }

  /** Alerts raised per business, site, computer and monitor type over a period, with time to resolve. */
  @Get('alert-frequency')
  @RequireCapability(CAP.ALERTS_VIEW)
  async alertFrequency(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.reports.alertFrequency(actor, parseReportQuery(q)) };
  }

  @Get('alert-frequency/export.csv')
  @RequireCapability(CAP.ALERTS_VIEW)
  @RateLimit(10)
  async alertFrequencyCsv(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>, @Res() res: Response) {
    await this.send(res, actor, 'alert-frequency', q);
  }

  /** Offline time per computer, measured from OFFLINE monitor alerts (no availability percentage: see the service). */
  @Get('offline-time')
  @RequireCapability(CAP.ALERTS_VIEW)
  async offlineTime(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.reports.offlineTime(actor, parseReportQuery(q)) };
  }

  @Get('offline-time/export.csv')
  @RequireCapability(CAP.ALERTS_VIEW)
  @RateLimit(10)
  async offlineTimeCsv(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>, @Res() res: Response) {
    await this.send(res, actor, 'offline-time', q);
  }

  /** Per software catalog entry: computers compliant, outdated, missing or unknown, from stored detection evidence (0.34). */
  @Get('software-compliance')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async softwareCompliance(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.reports.softwareCompliance(actor, parseReportQuery(q)) };
  }

  @Get('software-compliance/export.csv')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async softwareComplianceCsv(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>, @Res() res: Response) {
    await this.send(res, actor, 'software-compliance', q);
  }
}
