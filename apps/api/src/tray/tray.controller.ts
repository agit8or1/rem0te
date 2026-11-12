import { Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, Length, Matches, MaxLength, ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { TrayService } from './tray.service';
import { AssistService } from './assist.service';
import { ASSIST_CSS, ASSIST_EXPIRED_HTML, ASSIST_HTML, ASSIST_JS } from './assist-page';
import { ASSIST_CSP, SELF_HELP_IDS, assistCookie } from './tray-policy';

// ── DTOs ─────────────────────────────────────────────────────────────────────

/** Either the signed agent's device secret, or a standard tray's key. TrayService.identify decides which. */
class TrayAuthDto {
  @IsOptional() @IsString() @Matches(/^[0-9]{6,15}$/) rustdeskId?: string;
  @IsOptional() @IsString() @Length(16, 128) agentSecret?: string;
  @IsOptional() @IsString() @Length(10, 120) trayKey?: string;
  /** The Windows account in the session, as the agent (signed) or the tray (standard) reads it. */
  @IsOptional() @IsString() @Length(0, 128) localUser?: string;
}
export class TrayPairDto {
  @IsString() @Matches(/^[0-9]{6,15}$/) rustdeskId!: string;
  @IsString() @Length(16, 128) agentSecret!: string;
}
export class TrayStatusDto extends TrayAuthDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) delivered?: string[];
}
export class TrayCodeDto extends TrayAuthDto {}
export class TraySupportDto extends TrayAuthDto {
  @IsString() @Length(1, 8000) description!: string;
  // Checked by usageSample() / screenshot(): numbers in range, an inert charset, a real JPEG or PNG.
  @IsOptional() @IsObject() @Type(() => Object) usage?: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(960_000) screenshot?: string;
}
export class SelfHelpBeginDto extends TrayAuthDto {
  @IsString() @IsIn(SELF_HELP_IDS) tool!: string;
}
export class SelfHelpResultDto extends TrayAuthDto {
  @IsOptional() @IsString() @Length(1, 40) runId?: string;
  @IsOptional() @IsString() @IsIn(SELF_HELP_IDS) tool?: string;
  @IsIn(['succeeded', 'failed', 'refused']) outcome!: string;
  @IsOptional() @IsString() @MaxLength(2000) summary?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(40) @IsString({ each: true }) @MaxLength(400, { each: true }) detail?: string[];
  @IsOptional() @IsBoolean() offline?: boolean;
  @IsOptional() @IsString() @MaxLength(40) ranAt?: string;
}
export class RecordingDto {
  @IsOptional() @IsString() businessId?: string;
  @ValidateIf((_o, v) => v !== null) @IsBoolean() recording!: boolean | null;
}
export class PlatformRecordingDto {
  @IsBoolean() recording!: boolean;
}
export class AssistStartDto {
  @IsString() @Length(1, 8000) text!: string;
  @IsString() @Matches(/^[A-Za-z0-9_-]{8,64}$/) clientId!: string;
}
export class AssistMessageDto extends AssistStartDto {}
export class AssistReceiptsDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) shown?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) read?: string[];
}

// ── The tray on the computer ─────────────────────────────────────────────────

/**
 * The tray's routes (0.36). Public at the HTTP layer: every one authenticates
 * the computer in TrayService.identify — the signed agent's device secret
 * (signed channel only) or a standard tray's key — and acts only on that
 * computer. /tray/pair takes the device secret alone.
 */
@Controller('tray')
export class TrayDeviceController {
  constructor(private readonly tray: TrayService) {}

  @Post('pair')
  @Public()
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async pair(@Body() dto: TrayPairDto) {
    return { success: true, data: await this.tray.pair(dto) };
  }

  @Post('status')
  @Public()
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async status(@Body() dto: TrayStatusDto) {
    const dev = await this.tray.identify(dto);
    return { success: true, data: await this.tray.status(dev, dto) };
  }

  @Post('chat-code')
  @Public()
  @RateLimit(20)
  @HttpCode(HttpStatus.OK)
  async chatCode(@Body() dto: TrayCodeDto) {
    const dev = await this.tray.identify(dto);
    return { success: true, data: await this.tray.chatCode(dev, dto) };
  }

  @Post('support-requests')
  @Public()
  @RateLimit(10)
  async supportRequest(@Body() dto: TraySupportDto) {
    const dev = await this.tray.identify(dto);
    return { success: true, data: await this.tray.supportRequest(dev, dto) };
  }

  @Post('self-help/begin')
  @Public()
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async selfHelpBegin(@Body() dto: SelfHelpBeginDto) {
    const dev = await this.tray.identify(dto);
    return { success: true, data: await this.tray.selfHelpBegin(dev, dto) };
  }

  @Post('self-help/result')
  @Public()
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async selfHelpResult(@Body() dto: SelfHelpResultDto) {
    const dev = await this.tray.identify(dto);
    return { success: true, data: await this.tray.selfHelpResult(dev, dto) };
  }
}

// ── The portal side ──────────────────────────────────────────────────────────

/** GET /endpoints/:id/tray: the tray, self-help runs and tray requests for one computer. */
@Controller('endpoints/:id/tray')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class EndpointTrayController {
  constructor(private readonly tray: TrayService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async get(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.tray.endpointTray(actor, id) };
  }
}

function fresh(stepUp: StepUpService, req: Request) {
  const u = req.user as { sub?: string; iat?: number } | undefined;
  assertFresh(u?.sub ? stepUp.read(req, u.sub, u.iat)?.method ?? null : null, { message: 'Confirm it is you to change whether chats are recorded.' });
}

/**
 * Whether chats are recorded (0.36). Reading: anyone in the business (it is
 * shown to both sides of every chat anyway). Changing: a Business Owner for
 * their business, a Platform Admin for any and for the platform default —
 * always with fresh authentication, and audited (CHAT_RECORDING_CHANGED).
 */
@Controller('chat-recording')
@UseGuards(JwtAuthGuard)
export class ChatRecordingController {
  constructor(private readonly tray: TrayService, private readonly stepUp: StepUpService) {}

  @Get()
  async get(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.tray.recordingSettings(actor, businessId) };
  }

  @Put()
  @RateLimit(20)
  async put(@Actor() actor: ActorContext, @Body() dto: RecordingDto, @Req() req: Request) {
    fresh(this.stepUp, req);
    return { success: true, data: await this.tray.setBusinessRecording(actor, dto.businessId, dto.recording) };
  }

  @Put('platform')
  @RateLimit(20)
  async putPlatform(@Actor() actor: ActorContext, @Body() dto: PlatformRecordingDto, @Req() req: Request) {
    if (!actor.isPlatformAdmin) throw new ForbiddenException('Platform Admin access required');
    fresh(this.stepUp, req);
    return { success: true, data: await this.tray.setPlatformRecording(actor, dto.recording) };
  }
}

// ── The /assist page ─────────────────────────────────────────────────────────

function pageHeaders(res: Response, type: string) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Security-Policy', ASSIST_CSP);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

/** Writes from the page must carry this header: a cross-site form cannot set it. SameSite=Strict is the other half. */
function assertPageWrite(req: Request) {
  if (req.headers['x-assist'] !== '1') throw new ForbiddenException({ code: 'ASSIST_HEADER', message: 'Not from the chat window.' });
}

/**
 * /assist (0.36): the end-user chat page the tray opens, served by the API
 * and reached through the web app's /assist rewrite. No portal session is
 * read or accepted here; the only credential is the /assist cookie.
 */
@Controller('assist')
export class AssistController {
  constructor(private readonly assist: AssistService) {}

  /** The tray's one-time link. Consumes the code, sets the cookie, and leaves the URL at once. */
  @Get('open')
  @Public()
  @RateLimit(30)
  async open(@Query('c') c: string | undefined, @Res() res: Response) {
    const token = await this.assist.exchange(c);
    if (!token) {
      pageHeaders(res, 'text/html; charset=utf-8');
      res.status(410).send(ASSIST_EXPIRED_HTML);
      return;
    }
    pageHeaders(res, 'text/plain; charset=utf-8');
    res.setHeader('Set-Cookie', assistCookie(token));
    res.redirect(303, 'chat');
  }

  @Get('chat')
  @Public()
  @RateLimit(60)
  page(@Res() res: Response) {
    pageHeaders(res, 'text/html; charset=utf-8');
    res.send(ASSIST_HTML);
  }

  @Get('assist.js')
  @Public()
  @RateLimit(60)
  script(@Res() res: Response) {
    pageHeaders(res, 'text/javascript; charset=utf-8');
    res.send(ASSIST_JS);
  }

  @Get('assist.css')
  @Public()
  @RateLimit(60)
  style(@Res() res: Response) {
    pageHeaders(res, 'text/css; charset=utf-8');
    res.send(ASSIST_CSS);
  }

  @Get('api/state')
  @Public()
  @RateLimit(120)
  async state(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { success: true, data: await this.assist.state(req.headers.cookie) };
  }

  @Post('api/start')
  @Public()
  @RateLimit(10)
  async start(@Req() req: Request, @Body() dto: AssistStartDto) {
    assertPageWrite(req);
    return { success: true, data: await this.assist.start(req.headers.cookie, dto) };
  }

  @Post('api/messages')
  @Public()
  @RateLimit(60)
  async send(@Req() req: Request, @Body() dto: AssistMessageDto) {
    assertPageWrite(req);
    return { success: true, data: await this.assist.send(req.headers.cookie, dto) };
  }

  @Post('api/receipts')
  @Public()
  @RateLimit(120)
  @HttpCode(HttpStatus.OK)
  async receipts(@Req() req: Request, @Body() dto: AssistReceiptsDto) {
    assertPageWrite(req);
    return { success: true, data: await this.assist.receipts(req.headers.cookie, dto) };
  }

  @Post('api/end')
  @Public()
  @RateLimit(10)
  @HttpCode(HttpStatus.OK)
  async end(@Req() req: Request) {
    assertPageWrite(req);
    return { success: true, data: await this.assist.end(req.headers.cookie) };
  }
}
