import { Body, Controller, Get, NotFoundException, Param, Put, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { IsBoolean, IsIn } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { Public } from '../common/decorators/public.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { AccessControlService } from '../rbac/access-control.service';
import { StepUpService } from '../auth/step-up.service';
import { assertFresh } from '../security-controls/review';
import { UPDATE_TRUST_MODES, UpdateTrustService, type UpdateTrustMode } from './update-trust.service';

class ModeDto {
  @IsIn(UPDATE_TRUST_MODES) mode!: UpdateTrustMode;
  @IsBoolean() legacyPortalMigration!: boolean;
}

/**
 * The signed update repository, served byte-for-byte for agents. Public by
 * nature (an agent fetching an update has no session) and harmless to expose:
 * metadata and targets are signed offline and verified by the agent, and none
 * of it is secret.
 */
@Controller('public/updates')
export class UpdateMirrorController {
  constructor(private readonly svc: UpdateTrustService) {}

  @Get('metadata/:file')
  @Public()
  metadata(@Param('file') file: string, @Res() res: Response) {
    const p = this.svc.metadataPath(file);
    // Versioned files never change; timestamp.json (and the unversioned
    // root.json) must never be cached, or a CDN would serve a freeze attack
    // on the portal's behalf.
    res.setHeader('Cache-Control', /^\d/.test(file) ? 'public, max-age=31536000, immutable' : 'no-store');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(p);
  }

  @Get('targets/*path')
  @Public()
  target(@Param('path') raw: string | string[], @Res() res: Response) {
    const segments = Array.isArray(raw) ? raw : String(raw ?? '').split('/');
    if (!segments.length) throw new NotFoundException();
    const p = this.svc.targetPath(segments);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(p);
  }
}

@Controller('admin/update-trust')
@UseGuards(JwtAuthGuard)
export class UpdateTrustController {
  constructor(
    private readonly svc: UpdateTrustService,
    private readonly acl: AccessControlService,
    private readonly stepUp: StepUpService,
  ) {}

  @Get()
  async get(@Actor() actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: { mirror: this.svc.status(), ...(await this.svc.mode()), inventory: await this.svc.inventory() } };
  }

  @Put('mode')
  async setMode(@Actor() actor: ActorContext, @Body() dto: ModeDto, @Req() req: Request) {
    this.acl.assertPlatformAdmin(actor);
    const u = req.user as { sub?: string; iat?: number } | undefined;
    assertFresh(u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null);
    return { success: true, data: await this.svc.setMode(actor, { mode: dto.mode, legacyPortalMigration: dto.legacyPortalMigration }) };
  }
}
