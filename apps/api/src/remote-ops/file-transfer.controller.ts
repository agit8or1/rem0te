import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { RateLimit } from '../common/throttling';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP, PLATFORM_CAP } from '../rbac/capabilities';
import { StepUpService } from '../auth/step-up.service';
import { FileTransferService } from './file-transfer.service';

/**
 * Background file transfer, console side (0.78 Courier).
 *
 * Capabilities:
 *   - Sending a file needs `computers:files_upload`. Fetching one needs
 *     `computers:files_download`. Both are platform-only, and separate.
 *   - Listing, reading a transfer's state and cancelling need
 *     `computers:view`. The business's own member with Edit computers may
 *     cancel a transfer they could not start.
 *
 * The service checks scope and visibility on every route, so another
 * business's computer is a 404.
 */
@Controller('endpoints/:id/files')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class FileTransferController {
  constructor(private readonly files: FileTransferService, private readonly stepUp: StepUpService) {}

  private fresh(req: Request): string | null {
    const u = req.user as { sub?: string; iat?: number } | undefined;
    return u?.sub ? this.stepUp.read(req, u.sub, u.iat)?.method ?? null : null;
  }

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(@Actor() a: ActorContext, @Param('id') id: string) {
    return { success: true, data: await this.files.list(a, id) };
  }

  /** Send a file: path, size, SHA-256, overwrite, reason; a fresh confirmation (files.transfer). */
  @Post('uploads')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_FILES_UPLOAD)
  @RateLimit(10)
  async upload(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    return { success: true, data: await this.files.request(a, id, 'to_computer', body ?? {}, this.fresh(req)) };
  }

  /** Fetch a file: path, reason; a fresh confirmation (files.transfer). */
  @Post('downloads')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD)
  @RateLimit(10)
  async download(@Actor() a: ActorContext, @Param('id') id: string, @Body() body: Record<string, unknown>, @Req() req: Request) {
    return { success: true, data: await this.files.request(a, id, 'from_computer', body ?? {}, this.fresh(req)) };
  }

  @Get(':tid')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(240)
  async get(@Actor() a: ActorContext, @Param('id') id: string, @Param('tid') tid: string) {
    return { success: true, data: await this.files.get(a, id, tid) };
  }

  @Post(':tid/chunks')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_FILES_UPLOAD)
  @RateLimit(1200)
  @HttpCode(HttpStatus.OK)
  async putChunk(@Actor() a: ActorContext, @Param('id') id: string, @Param('tid') tid: string, @Body() body: { seq?: unknown; data?: unknown; sha256?: unknown }) {
    return { success: true, data: await this.files.putChunk(a, id, tid, body ?? {}) };
  }

  @Get(':tid/chunks/:seq')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD)
  @RateLimit(1200)
  async getChunk(@Actor() a: ActorContext, @Param('id') id: string, @Param('tid') tid: string, @Param('seq') seq: string) {
    return { success: true, data: await this.files.getChunk(a, id, tid, seq) };
  }

  @Post(':tid/received')
  @RequireCapability(PLATFORM_CAP.COMPUTERS_FILES_DOWNLOAD)
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async received(@Actor() a: ActorContext, @Param('id') id: string, @Param('tid') tid: string, @Body() body: { sha256?: unknown }) {
    return { success: true, data: await this.files.received(a, id, tid, body ?? {}) };
  }

  /** Cancel: its technician cancels it; a Platform Admin or the business's own member with Edit computers revokes it. Never asks. */
  @Post(':tid/cancel')
  @RequireCapability(CAP.COMPUTERS_VIEW)
  @RateLimit(30)
  @HttpCode(HttpStatus.OK)
  async cancel(@Actor() a: ActorContext, @Param('id') id: string, @Param('tid') tid: string) {
    return { success: true, data: await this.files.cancel(a, id, tid) };
  }
}
