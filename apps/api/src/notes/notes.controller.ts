import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsEnum, IsOptional, IsString, Length } from 'class-validator';
import { NotesService } from './notes.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import { NoteVisibility } from '@prisma/client';

// class-validator decorators are REQUIRED — see comment in customers.controller.ts.
class CreateNoteDto {
  @IsString() @Length(1, 8192)                     content!: string;
  @IsOptional() @IsString()                         endpointId?: string;
  @IsOptional() @IsString()                         customerId?: string;
  @IsOptional() @IsString()                         sessionId?: string;
  @IsOptional() @IsEnum(NoteVisibility)             visibility?: NoteVisibility;
  @IsOptional() @IsBoolean()                        isPinned?: boolean;
}

class UpdateNoteDto {
  @IsOptional() @IsString() @Length(1, 8192)       content?: string;
  @IsOptional() @IsBoolean()                        isPinned?: boolean;
}

class AddCommentDto {
  @IsString() @Length(1, 4096)                     content!: string;
}

@Controller('notes')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @RequirePermissions('notes:read')
  async list(
    @CurrentUser() user: JwtPayload,
    @Query('endpointId') endpointId?: string,
    @Query('customerId') customerId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (!user.tenantId) return { success: false, data: [] };
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;

    let data;
    if (endpointId) data = await this.notesService.findByEndpoint(user.tenantId, endpointId, pageNum, limitNum);
    else if (customerId) data = await this.notesService.findByCustomer(user.tenantId, customerId, pageNum, limitNum);
    else if (sessionId) data = await this.notesService.findBySession(user.tenantId, sessionId);
    else data = { data: [], total: 0, page: pageNum, limit: limitNum };

    return { success: true, ...data };
  }

  @Post()
  @RequirePermissions('notes:write')
  async create(@CurrentUser() user: JwtPayload, @Body() dto: CreateNoteDto) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.notesService.create(user.tenantId, user.sub, dto);
    return { success: true, data };
  }

  @Patch(':id')
  @RequirePermissions('notes:write')
  async update(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateNoteDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const isAdmin = user.roleType === 'TENANT_ADMIN' || user.roleType === 'TENANT_OWNER' || user.isPlatformAdmin;
    const data = await this.notesService.update(user.tenantId, id, user.sub, dto, isAdmin);
    return { success: true, data };
  }

  @Delete(':id')
  @RequirePermissions('notes:write')
  async delete(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const isAdmin = user.roleType === 'TENANT_ADMIN' || user.roleType === 'TENANT_OWNER' || user.isPlatformAdmin;
    await this.notesService.delete(user.tenantId, id, user.sub, isAdmin);
    return { success: true };
  }

  @Post(':id/comments')
  @RequirePermissions('notes:write')
  async addComment(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: AddCommentDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    const data = await this.notesService.addComment(user.tenantId, id, user.sub, dto.content);
    return { success: true, data };
  }
}
