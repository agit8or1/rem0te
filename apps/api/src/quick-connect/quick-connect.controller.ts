import {
  Body, Controller, Get, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, Length, Matches } from 'class-validator';
import { QuickConnectService } from './quick-connect.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';

class QuickConnectDto {
  // Accept the grouped form the client displays ("123 456 789") as well as raw digits.
  @IsString() @Matches(/^[0-9\s-]{6,24}$/, { message: 'Remote ID must be the number shown by the Quick Connect client' })
  rustdeskId!: string;

  @IsString() @Length(4, 128) password!: string;

  @IsOptional() @IsString() @Length(0, 128)  contactName?: string;
  @IsOptional() @IsString() @Length(0, 1024) issueDescription?: string;
}

class EndSessionDto {
  @IsOptional() @IsIn(['completed', 'failed', 'cancelled']) result?: 'completed' | 'failed' | 'cancelled';
}

@Controller('quick-connect')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class QuickConnectController {
  constructor(private readonly quickConnect: QuickConnectService) {}

  /**
   * Whether this user can use Quick Connect right now, and why not if not.
   * Intentionally ungated — the answer is how the UI decides to show the page
   * at all, and it leaks nothing beyond the caller's own permissions.
   */
  @Get('status')
  async status(@Actor() actor: ActorContext) {
    return { success: true, data: await this.quickConnect.status(actor) };
  }

  /**
   * Start a temporary support session against an ID + password the remote
   * person read out. The password is relayed to the caller and never stored.
   */
  @Post('connect')
  @RequireCapability(CAP.QUICK_CONNECT)
  async connect(@Actor() actor: ActorContext, @Body() dto: QuickConnectDto) {
    return { success: true, data: await this.quickConnect.connect(actor, dto) };
  }

  @Post('sessions/:id/end')
  @RequireCapability(CAP.QUICK_CONNECT)
  async end(
    @Actor() actor: ActorContext,
    @Param('id') id: string,
    @Body() dto: EndSessionDto,
  ) {
    return { success: true, data: await this.quickConnect.end(actor, id, dto.result ?? 'completed') };
  }

  @Get('sessions')
  @RequireCapability(CAP.QUICK_CONNECT)
  async sessions(
    @Actor() actor: ActorContext,
    @Query('businessId') businessId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.quickConnect.listSessions(actor, {
      businessId,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 25,
    });
    return { success: true, data };
  }
}
