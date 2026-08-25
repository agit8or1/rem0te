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
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { NoteVisibility } from '@prisma/client';

// class-validator decorators are REQUIRED — the global ValidationPipe runs
// with { whitelist: true, forbidNonWhitelisted: true }.
class CreateNoteDto {
  @IsString() @Length(1, 8192)                     content!: string;
  @IsOptional() @IsString()                         endpointId?: string;
  @IsOptional() @IsString()                         businessId?: string;
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
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @RequireCapability(CAP.COMPUTERS_VIEW)
  async list(
    @Actor() actor: ActorContext,
    @Query('endpointId') endpointId?: string,
    @Query('businessId') businessId?: string,
    @Query('customerId') customerId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    const business = businessId ?? customerId;

    let data;
    if (endpointId) data = await this.notesService.findByEndpoint(actor, endpointId, pageNum, limitNum);
    else if (business) data = await this.notesService.findByBusiness(actor, business, pageNum, limitNum);
    else if (sessionId) data = { data: await this.notesService.findBySession(actor, sessionId), total: 0, page: pageNum, limit: limitNum };
    else data = { data: [], total: 0, page: pageNum, limit: limitNum };

    return { success: true, ...data };
  }

  @Post()
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async create(@Actor() actor: ActorContext, @Body() dto: CreateNoteDto) {
    return { success: true, data: await this.notesService.create(actor, dto) };
  }

  @Patch(':id')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async update(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: UpdateNoteDto) {
    return { success: true, data: await this.notesService.update(actor, id, dto) };
  }

  @Delete(':id')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async delete(@Actor() actor: ActorContext, @Param('id') id: string) {
    await this.notesService.delete(actor, id);
    return { success: true };
  }

  @Post(':id/comments')
  @RequireCapability(CAP.COMPUTERS_EDIT)
  async addComment(@Actor() actor: ActorContext, @Param('id') id: string, @Body() dto: AddCommentDto) {
    return { success: true, data: await this.notesService.addComment(actor, id, dto.content) };
  }
}
