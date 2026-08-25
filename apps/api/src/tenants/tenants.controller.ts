import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { TenantsService } from './tenants.service';
import { UpdateBrandingDto, UpdateSettingsDto, UpdateTenantDto } from './dto/create-tenant.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';

const UPLOAD_DIR = '/opt/reboot-remote/uploads/logos';
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];

/**
 * Platform configuration — branding, RustDesk server settings, MFA policy.
 *
 * This used to be the multi-tenant surface. There is now exactly one Rem0te
 * operator, so everything here is platform-level and Platform Admin only.
 * Businesses are managed through /businesses.
 *
 * `tenants` stays as a route alias so the deployed web build keeps working
 * across the upgrade.
 */
@Controller(['platform', 'tenants'])
@UseGuards(JwtAuthGuard)
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly acl: AccessControlService,
  ) {}

  @Get()
  async findAll(@Actor() actor: ActorContext) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.tenantsService.findAll() };
  }

  @Get(':id')
  async findOne(@Actor() actor: ActorContext, @Param('id') id: string) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.tenantsService.findOne(id) };
  }

  @Patch(':id')
  async update(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() dto: UpdateTenantDto,
  ) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.tenantsService.update(id, actor.userId, dto) };
  }

  @Patch(':id/branding')
  async updateBranding(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() dto: UpdateBrandingDto,
  ) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.tenantsService.updateBranding(id, actor.userId, dto) };
  }

  @Patch(':id/settings')
  async updateSettings(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() dto: UpdateSettingsDto,
  ) {
    this.acl.assertPlatformAdmin(actor);
    return { success: true, data: await this.tenantsService.updateSettings(id, actor.userId, dto) };
  }

  @Patch(':id/branding/logo')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          fs.mkdirSync(UPLOAD_DIR, { recursive: true });
          cb(null, UPLOAD_DIR);
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname).toLowerCase() || '.png';
          cb(null, `${Date.now()}-${randomBytes(16).toString('hex')}${ext}`);
        },
      }),
      fileFilter: (_req, file, cb) => {
        cb(null, ALLOWED_MIME.includes(file.mimetype));
      },
      limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
    }),
  )
  async uploadLogo(@Actor() actor: ActorContext, @UploadedFile() file: Express.Multer.File) {
    this.acl.assertPlatformAdmin(actor);
    if (!file) throw new BadRequestException('No valid image file provided (JPEG/PNG/GIF/WebP/SVG, max 2 MB)');
    return { success: true, data: { url: `/uploads/logos/${file.filename}` } };
  }
}
