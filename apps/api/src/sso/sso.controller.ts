import {
  Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { SsoError, SsoService } from './sso.service';
import { Public } from '../common/decorators/public.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RateLimit } from '../common/throttling';
import { StepUpService } from '../auth/step-up.service';
import type { ActorContext } from '../rbac/access-control.service';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import {
  SSO_STATE_COOKIE, clearSsoStateCookie, safeReturnTo, setAccessCookie, setPartialCookie, setSsoStateCookie,
} from '../auth/cookies';

export class ProviderDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsString() @MaxLength(500) issuer?: string;
  @IsOptional() @IsString() @MaxLength(255) clientId?: string;
  // null clears it (public client, PKCE only).
  @IsOptional() @IsString() @MaxLength(1000) clientSecret?: string | null;
  @IsOptional() @IsString() @MaxLength(500) redirectUri?: string;
  @IsOptional() @IsString() @MaxLength(500) scopes?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsBoolean() allowProvisioning?: boolean;
  @IsOptional() @IsString() @MaxLength(64) groupsClaim?: string | null;
}
export class MappingDto {
  @IsString() @MaxLength(256) groupValue!: string;
  @IsString() @MaxLength(64) businessId!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) capabilities?: string[];
}
class LinkDto {
  @IsOptional() @IsString() @MaxLength(300) returnTo?: string;
}

/** Provider configuration. Platform Admin only; every change needs step-up. */
@Controller('sso/providers')
export class SsoAdminController {
  constructor(private readonly svc: SsoService, private readonly stepUp: StepUpService) {}

  @Get()
  async list(@Actor() actor: ActorContext) {
    return { success: true, data: await this.svc.listProviders(actor) };
  }

  @Post()
  async create(@Actor() actor: ActorContext, @Body() dto: ProviderDto, @Req() req: Request) {
    await this.svc.listProviders(actor); // admin check before step-up
    await this.stepUp.assert(req, 'sso.configure');
    return { success: true, data: await this.svc.createProvider(actor, dto) };
  }

  @Patch(':id')
  async update(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: ProviderDto, @Req() req: Request) {
    await this.svc.listProviders(actor);
    await this.stepUp.assert(req, 'sso.configure');
    return { success: true, data: await this.svc.updateProvider(actor, id, dto) };
  }

  @Delete(':id')
  async remove(@Actor() actor: ActorContext, @Param('id') id: string, @Req() req: Request) {
    await this.svc.listProviders(actor);
    await this.stepUp.assert(req, 'sso.configure');
    return { success: true, data: await this.svc.deleteProvider(actor, id) };
  }

  @Post(':id/test')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async test(@Actor() actor: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.svc.testProvider(actor, id) };
  }

  @Post(':id/mappings')
  async addMapping(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: MappingDto, @Req() req: Request) {
    await this.svc.listProviders(actor);
    await this.stepUp.assert(req, 'sso.configure');
    return { success: true, data: await this.svc.addMapping(actor, id, dto) };
  }

  @Delete(':id/mappings/:mappingId')
  async removeMapping(@Actor() actor: ActorContext, @Param('id') id: string, @Param('mappingId') mappingId: string, @Req() req: Request) {
    await this.svc.listProviders(actor);
    await this.stepUp.assert(req, 'sso.configure');
    return { success: true, data: await this.svc.removeMapping(actor, id, mappingId) };
  }
}

/** The browser side of sign-in, and a user's own linked identities. */
@Controller('auth/sso')
export class SsoAuthController {
  constructor(
    private readonly svc: SsoService,
    private readonly stepUp: StepUpService,
    private readonly config: ConfigService,
  ) {}

  private web(path: string) {
    return `${(this.config.get<string>('FRONTEND_URL') ?? '').replace(/\/+$/, '')}${path}`;
  }

  @Public()
  @Get('providers')
  @RateLimit(30)
  async providers() {
    return { success: true, data: await this.svc.enabledProviders() };
  }

  @Public()
  @Get(':id/start')
  @RateLimit(20)
  async start(@Param('id') id: string, @Query('returnTo') returnTo: string | undefined, @Res() res: Response) {
    try {
      const { url, state } = await this.svc.start(id, 'LOGIN', { returnTo });
      setSsoStateCookie(res, state);
      return res.redirect(302, url);
    } catch {
      return res.redirect(302, this.web('/login?sso_error=unavailable'));
    }
  }

  @Public()
  @Get('callback')
  @RateLimit(20)
  async callback(@Query() query: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    const cookieState = (req.cookies as Record<string, string> | undefined)?.[SSO_STATE_COOKIE];
    clearSsoStateCookie(res);
    try {
      const out = await this.svc.callback(query, cookieState, req.ip ?? 'unknown', req.headers['user-agent'] ?? '');
      if (out.kind === 'linked') return res.redirect(302, this.web(`${safeReturnTo(out.returnTo)}${out.returnTo.includes('?') ? '&' : '?'}sso=linked`));
      const r = out.result;
      if (r.requiresMfa && 'partialToken' in r && r.partialToken) {
        setPartialCookie(res, r.partialToken);
        return res.redirect(302, this.web('/mfa'));
      }
      if ('accessToken' in r && r.accessToken) {
        setAccessCookie(res, r.accessToken);
        return res.redirect(302, this.web(safeReturnTo(out.returnTo)));
      }
      return res.redirect(302, this.web('/login?sso_error=account'));
    } catch (e) {
      const code = e instanceof SsoError ? e.code : 'failed';
      const page = e instanceof SsoError && e.linkFlow ? '/account' : '/login';
      return res.redirect(302, this.web(`${page}?sso_error=${encodeURIComponent(code)}`));
    }
  }

  /** Start linking a provider identity to the signed-in account. */
  @Post(':id/link')
  @HttpCode(HttpStatus.OK)
  @RateLimit(10)
  async link(
    @CurrentUser() user: JwtPayload, @Param('id') id: string, @Body() dto: LinkDto,
    @Req() req: Request, @Res({ passthrough: true }) res: Response,
  ) {
    await this.stepUp.assert(req, 'sso.configure');
    const { url, state } = await this.svc.start(id, 'LINK', { userId: user.sub, returnTo: dto.returnTo ?? '/account' });
    setSsoStateCookie(res, state);
    return { success: true, data: { url } };
  }

  @Get('identities')
  async identities(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.svc.myIdentities(user.sub) };
  }

  @Delete('identities/:id')
  async unlink(@CurrentUser() user: JwtPayload, @Param('id') id: string, @Req() req: Request) {
    await this.stepUp.assert(req, 'sso.configure');
    return { success: true, data: await this.svc.unlink(user.sub, id, req.ip) };
  }
}
