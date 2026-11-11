import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { ScriptLibraryService } from './script-library.service';

/**
 * The script library: write, version, diff and review PowerShell scripts.
 *
 * There is deliberately no route here that runs, sends or schedules a
 * script, and none can be added without failing §23 of the security
 * invariants: a script would run only as a signed action, approved on the
 * approval signer and verified by the signed agent (docs/script-library.md).
 * A review decision is a record in this database, not an authorization any
 * computer accepts.
 */
@Controller('scripts')
@UseGuards(JwtAuthGuard)
export class ScriptLibraryController {
  constructor(private readonly svc: ScriptLibraryService, private readonly stepUp: StepUpService) {}

  @Get()
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.svc.list(actor, businessId) };
  }

  @Post()
  @RateLimit(20)
  async create(@Actor() actor: ActorContext, @Body() body: unknown) {
    return { success: true, data: await this.svc.create(actor, body) };
  }

  @Get(':id')
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.get(actor, id) };
  }

  @Get(':id/diff')
  async diff(@Actor() actor: ActorContext, @Param('id') id: string, @Query('from', ParseIntPipe) from: number, @Query('to', ParseIntPipe) to: number) {
    return { success: true, data: await this.svc.diff(actor, id, from, to) };
  }

  @Post(':id/versions')
  @RateLimit(30)
  async newVersion(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: unknown) {
    return { success: true, data: await this.svc.newVersion(actor, id, body) };
  }

  @Get(':id/versions/:version')
  async version(@Actor() actor: ActorContext, @Param('id') id: string, @Param('version', ParseIntPipe) n: number) {
    return { success: true, data: await this.svc.version(actor, id, n) };
  }

  @Post(':id/versions/:version/submit')
  @HttpCode(HttpStatus.OK)
  async submit(@Actor() actor: ActorContext, @Param('id') id: string, @Param('version', ParseIntPipe) n: number) {
    return { success: true, data: await this.svc.submit(actor, id, n) };
  }

  @Post(':id/versions/:version/withdraw')
  @HttpCode(HttpStatus.OK)
  async withdraw(@Actor() actor: ActorContext, @Param('id') id: string, @Param('version', ParseIntPipe) n: number) {
    return { success: true, data: await this.svc.withdraw(actor, id, n) };
  }

  /** Approve or reject. Approving needs fresh authentication; the service asks for it after the identity and hash checks. */
  @Post(':id/versions/:version/review')
  @HttpCode(HttpStatus.OK)
  @RateLimit(20)
  async review(@Actor() actor: ActorContext, @Param('id') id: string, @Param('version', ParseIntPipe) n: number, @Body() body: unknown, @Req() req: Request) {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    const fresh = u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
    return { success: true, data: await this.svc.review(actor, id, n, body, fresh) };
  }
}
