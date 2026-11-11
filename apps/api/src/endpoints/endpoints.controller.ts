import type { LaunchMode } from '../security-controls/access-policy.service';
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Req, Res, UseGuards, HttpCode, HttpStatus,
  ServiceUnavailableException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { EndpointsService } from './endpoints.service';
import { TrmmResolverService } from './trmm-resolver.service';
import { RustdeskService } from '../common/rustdesk.service';
import { CreateEndpointDto, UpdateEndpointDto, AddTagDto, AddAliasDto, RedeemGrantDto, GrantAccessDto } from './dto/create-endpoint.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import { RateLimit } from '../common/throttling';
import { StepUpService } from '../auth/step-up.service';
import { SessionEventsService } from '../sessions/session-events.service';
import { PublicUrlService } from '../platform/public-url.service';
import { EndpointListService, parseListQuery } from './endpoint-list.service';

/**
 * Computers.
 *
 * The capability decorators here gate the verb. The business the verb lands
 * on is resolved inside EndpointsService for every single route — a path
 * parameter naming another business's computer produces a 404, not a leak.
 */
function parseLaunchMode(raw: string | undefined): LaunchMode {
  if (raw === undefined || raw === '' || raw === 'control') return 'control';
  if (raw === 'view_only' || raw === 'elevated' || raw === 'unattended') return raw;
  throw new BadRequestException('mode must be control, view_only, elevated or unattended');
}

@Controller('endpoints')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class EndpointsController {
  constructor(
    private readonly svc: EndpointsService,
    private readonly rustdesk: RustdeskService,
    private readonly trmm: TrmmResolverService,
    private readonly stepUp: StepUpService,
    private readonly sessionEvents: SessionEventsService,
    private readonly urls: PublicUrlService,
    private readonly list_: EndpointListService,
  ) {}

  @Get('connected')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async connected(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.findConnected(actor) };
  }

  /**
   * "My Computers" — what this specific person may connect to. No admin
   * capability required beyond `computers:view`, so an ordinary Business User
   * always reaches their own assigned machines.
   */
  @Get('mine')
  async mine(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.myComputers(actor) };
  }

  /**
   * The device list (0.31): server-side search, filters, sort and pages over
   * the computers this caller can see. Scoping lives in EndpointListService.
   */
  @Get('list')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async deviceList(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>) {
    return { success: true, data: await this.list_.list(actor, parseListQuery(q)) };
  }

  /** The same view as CSV, every page at once. Audited (ENDPOINT_LIST_EXPORTED) before it is sent. */
  @Get('list/export.csv')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(10)
  async deviceListExport(@Actor() actor: ActorContext, @Query() q: Record<string, unknown>, @Res() res: Response) {
    const out = await this.list_.exportCsv(actor, parseListQuery(q));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Rows', String(out.rows));
    res.send(out.csv);
  }

  /**
   * One-click Connect. Mints a short-lived single-use grant for the launcher
   * and also returns the credentials for the current browser flow. Both paths
   * run the same authorization check and both are audited.
   */
  // No @RequireCapability(computers:connect): a preset-backed technician holds
  // no such capability by design, and authorizeConnect decides every actor —
  // members still need computers:connect there, exactly as before.
  @Post(':id/connect')
  @HttpCode(HttpStatus.OK)
  @RateLimit(30)
  async connect(
    @Actor() actor: ActorContext, @Param('id') id: string,
    @CurrentUser() u: JwtPayload, @Req() req: Request,
    @Query('supportRequestId') supportRequestId?: string,
    @Query('mode') mode?: string,
  ) {
    const launchMode = parseLaunchMode(mode);
    // The grant releases the permanent password to the launcher, so minting
    // one that would needs the same fresh step-up as Reveal. It also primes
    // the step-up the Connect script download right after this needs.
    const grant = await this.svc.createConnectionGrant(actor, id, launchMode, () => this.credentialGate(req, u));
    const info = await this.svc.connectInfo(actor, id, {
      mode: launchMode,
      supportRequestId: supportRequestId ? await this.svc.supportRequestForConnect(actor, supportRequestId, id) : undefined,
    });
    // Never the password itself: the browser holds only the single-use,
    // 90-second launcher grant. The password reaches a person through
    // GET :id/password or the Connect script, both behind step-up and audited
    // as a reveal.
    const { password: _withheld, ...rest } = info;
    void _withheld;
    return {
      success: true,
      data: {
        ...rest,
        grantToken: grant.token,
        grantExpiresAt: grant.expiresAt,
        launchUri: `rem0te://connect/${grant.token}`,
      },
    };
  }

  /**
   * Connect as one downloadable file.
   *
   * The `rustdesk://` link the Connect button opens cannot carry a server
   * address, so it only works on a machine whose RustDesk is already pointed
   * here. This route hands back a script that needs nothing to be true in
   * advance: it installs RustDesk if the machine does not have it, applies
   * this server's configuration, and opens the session.
   *
   * Same authorization and the same audit entry as POST :id/connect — it goes
   * through connectInfo, which is what decides whether this actor may see the
   * endpoint's password at all.
   */
  @Get(':id/connect.cmd')
  @RateLimit(30)
  async connectScript(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Res() res: Response,
    @CurrentUser() u: JwtPayload,
    @Req() req: Request,
    @Query('session') reuseSessionId?: string,
    @Query('mode') mode?: string,
  ) {
    // The script carries the permanent password, so it is a reveal: the same
    // MFA check and fresh step-up as GET :id/password, and the same audit
    // entry, written before the password is read out.
    const info = await this.svc.connectInfo(actor, id, {
      reuseSessionId, mode: parseLaunchMode(mode), admit: true,
      releaseCredential: true, credentialGate: () => this.credentialGate(req, u),
    });
    const telemetryToken = info.sessionId ? await this.sessionEvents.issueTelemetryToken(info.sessionId) : null;
    const config = await this.rustdesk.serverConfig();
    if (!config) {
      throw new ServiceUnavailableException(
        'No RustDesk relay host is configured. A Platform Admin must set it under Settings.',
      );
    }

    const name = info.computer.hostname ?? info.computer.name ?? info.rustdeskId;
    const script = this.rustdesk.buildConnectCmd({
      config,
      peerId: info.rustdeskId,
      password: info.password ?? null,
      // Windows filenames reject these outright, and the value reaches both a
      // Content-Disposition header and a `title` line inside the script.
      // eslint-disable-next-line no-control-regex -- control chars are exactly what this strips
      endpointName: String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 60),
      clientDownloadUrl: `${this.urls.apiConfigured() ?? ''}/api/v1/public/quick-connect/download/windows`,
      clientVersion: await this.rustdesk.pinnedOrLatestVersion(),
      telemetry: telemetryToken
        ? { url: `${this.urls.apiConfigured() ?? ''}/api/v1/sessions/telemetry`, token: telemetryToken }
        : null,
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="Connect to ${String(name).replace(/[^A-Za-z0-9._ -]/g, '')}.cmd"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  }

  /**
   * Redeem a ConnectionGrant. Public because the launcher has no session —
   * the single-use token is itself the proof, and the service re-runs the
   * full authorization check before handing anything back.
   */
  @Post('grants/redeem')
  @Public()
  @HttpCode(HttpStatus.OK)
  @RateLimit(60)
  async redeemGrant(@Body() body: RedeemGrantDto, @Req() req: Request) {
    const data = await this.svc.redeemConnectionGrant(body.token, req.ip);
    return { success: true, data };
  }

  // ── Per-computer access ───────────────────────────────────────────────────

  @Get(':id/access')
  @RequireCapability(CAP.USERS_VIEW)
  async listAccess(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.listAccess(actor, id) };
  }

  @Post(':id/access')
  @RequireCapability(CAP.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  async grantAccess(@Actor() actor: ActorContext, @Param('id') id: string, @Body() body: GrantAccessDto) {
    return { success: true, data: await this.svc.grantAccess(actor, id, body.userId, body) };
  }

  @Delete(':id/access/:userId')
  @RequireCapability(CAP.USERS_MANAGE)
  @HttpCode(HttpStatus.OK)
  async revokeAccess(@Actor() actor: ActorContext, @Param('id') id: string, @Param('userId') userId: string) {
    await this.svc.revokeAccess(actor, id, userId);
    return { success: true };
  }

  @Patch(':id/access-mode')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async setAccessMode(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() body: { accessMode: 'ASSIGNED_USERS' | 'COMPANY_WIDE' },
  ) {
    return { success: true, data: await this.svc.setAccessMode(actor, id, body.accessMode) };
  }

  // ── Credentials ───────────────────────────────────────────────────────────

  @Post(':id/rotate-credential')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async rotateCredential(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.rotateCredential(actor, id) };
  }

  /**
   * What releasing a computer's permanent password needs, wherever it is
   * released: a session that satisfied MFA if this person has MFA, and a
   * fresh step-up (credential.reveal).
   */
  private async credentialGate(req: Request, u: JwtPayload): Promise<void> {
    if (u.mfaVerified !== true && await this.svc.userHasMfa(u.sub)) {
      throw new ForbiddenException({ code: 'MFA_REQUIRED', message: 'Sign in again with your authenticator to reveal a computer password.' });
    }
    await this.stepUp.assert(req, 'credential.reveal');
  }

  @Get(':id/password')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  async getPassword(
    @Actor() actor: ActorContext,
    @CurrentUser() u: JwtPayload,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    // Access first, so a person with no business here is refused rather
    // than asked to re-authenticate. Then MFA and a recent re-authentication
    // (on by default): a permanent password outlives the session that
    // revealed it. getPassword re-checks access itself.
    await this.svc.assertPasswordAccess(actor, id);
    await this.credentialGate(req, u);
    const password = await this.svc.getPassword(actor, id);
    return { success: true, data: { hasPassword: password !== null, password } };
  }

  @Patch(':id/password')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async setPassword(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body('password') password: string | null,
  ) {
    await this.svc.setPassword(actor, id, password ?? null);
    return { success: true };
  }

  // ── Tactical RMM ──────────────────────────────────────────────────────────

  /**
   * Resolve a Tactical RMM agent to a computer.
   *
   * Reached from a TRMM URL Action, which opens this in the technician's
   * browser — so it authenticates as the person who clicked it and is scoped
   * to what they can already see. No API key travels in the URL, deliberately:
   * a URL Action ends up in browser history, and TRMM's own audit log.
   */
  @Get('trmm/resolve')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(60)
  async trmmResolve(@Actor() actor: ActorContext, @Query() q: Record<string, string>) {
    return { success: true, data: await this.trmm.resolve(actor, {
      hostname: q.host ?? q.hostname,
      clientName: q.client ?? q.clientName,
      siteName: q.site ?? q.siteName,
      agentId: q.agent ?? q.agentId,
    }) };
  }

  /** Record which computer a TRMM agent is, so the next launch is exact. */
  @Post('trmm/link')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async trmmLink(
    @Actor() actor: ActorContext,
    @Body() body: { endpointId?: string; agentId?: string },
  ) {
    if (!body.endpointId || !body.agentId) {
      throw new BadRequestException('endpointId and agentId are required');
    }
    return { success: true, data: await this.trmm.remember(actor, body.endpointId, body.agentId) };
  }

  // ── Inventory, updates and event logs ─────────────────────────────────────

  @Get(':id/inventory')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async inventory(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.getInventory(actor, id) };
  }

  // Queues a collection for the endpoint's next heartbeat. Rate limited
  // because the button is right there and the work lands on someone's
  // production machine, not on this server.
  @Post(':id/inventory/refresh')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async refreshInventory(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.requestInventoryRefresh(actor, id) };
  }

  // Re-runs the installer on the machine, which is what upgrades the agent.
  // Idempotent and non-destructive, but it is a software install on someone's
  // computer and it pulls the client binary again, so: COMPUTERS_EDIT, rate
  // limited, and audited in the service.
  @Post(':id/reinstall-agent')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async reinstallAgent(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.requestAgentReinstall(actor, id) };
  }

  // Accept the new device secret a computer has been heartbeating with since
  // its bound one stopped matching. See EndpointsService.acceptDeviceSecret.
  @Post(':id/accept-device-secret')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async acceptDeviceSecret(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.acceptDeviceSecret(actor, id) };
  }

  // The last query run against this computer, so returning to the tab shows
  // what was already fetched instead of an empty form.
  @Get(':id/event-log/latest')
  @RequireCapability(CAP.COMPUTERS_EVENT_LOGS)
  async latestEventLog(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.latestEventLog(actor, id) };
  }

  @Post(':id/event-log')
  @RequireCapability(CAP.COMPUTERS_EVENT_LOGS)
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async requestEventLog(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return { success: true, data: await this.svc.requestEventLog(actor, id, body) };
  }

  // Polled by the UI while a request is outstanding. The capability check for
  // event-log contents is inside the service, keyed on the command's type.
  @Get(':id/commands/:commandId')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async command(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Param('commandId') commandId: string,
  ) {
    return { success: true, data: await this.svc.getCommand(actor, id, commandId) };
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() actor: ActorContext, @Query() q: Record<string, string>) {
    return { success: true, data: await this.svc.findAll(actor, {
      search: q.search,
      // `businessId` is the current name; `customerId` still accepted so an
      // in-flight client does not break mid-upgrade.
      businessId: q.businessId ?? q.customerId,
      status: q.status,
      tag: q.tag, platform: q.platform,
      page: q.page ? parseInt(q.page) : 1,
      limit: q.limit ? parseInt(q.limit) : 50,
    }) };
  }

  @Get(':id')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.findOne(actor, id) };
  }

  @Post()
  @RequireCapability(CAP.COMPUTERS_ADD)
  async create(@Actor() actor: ActorContext, @Body() dto: CreateEndpointDto) {
    return { success: true, data: await this.svc.create(actor, dto) };
  }

  @Patch(':id')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async update(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: UpdateEndpointDto) {
    return { success: true, data: await this.svc.update(actor, id, dto) };
  }

  @Patch(':id/archive')
  @RequireCapability(CAP.COMPUTERS_REMOVE)
  @HttpCode(HttpStatus.OK)
  async archive(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.archive(actor, id) };
  }

  @Patch(':id/restore')
  @RequireCapability(CAP.COMPUTERS_REMOVE)
  @HttpCode(HttpStatus.OK)
  async restore(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.restore(actor, id) };
  }

  @Post(':id/tags')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async addTag(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: AddTagDto) {
    await this.svc.addTag(actor, id, dto.tag);
    return { success: true };
  }

  @Delete(':id/tags/:tag')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async removeTag(@Actor() actor: ActorContext, @Param('id') id: string, @Param('tag') tag: string) {
    await this.svc.removeTag(actor, id, tag);
    return { success: true };
  }

  @Post(':id/aliases')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async addAlias(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: AddAliasDto) {
    return { success: true, data: await this.svc.addAlias(actor, id, dto.alias, dto.isPrimary) };
  }

  @Delete(':id/aliases/:aliasId')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async removeAlias(@Actor() actor: ActorContext, @Param('id') id: string, @Param('aliasId') aliasId: string) {
    await this.svc.removeAlias(actor, id, aliasId);
    return { success: true };
  }

  @Post(':id/timeline/generate')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  @HttpCode(HttpStatus.OK)
  async generateTimeline(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.generateTimeline(actor, id) };
  }
}
