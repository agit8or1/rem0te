import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MinLength,
} from 'class-validator';
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
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CapabilitiesGuard } from '../common/guards/capabilities.guard';
import { RequireCapability } from '../common/decorators/require-capability.decorator';
import { Actor } from '../common/decorators/actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

class UpdateProfileDto {
  @IsOptional() @IsString() @Length(1, 64)  firstName?: string;
  @IsOptional() @IsString() @Length(1, 64)  lastName?: string;
  @IsOptional() @IsEmail()                   email?: string;
  @IsOptional() @IsString() @Length(0, 32) @Matches(/^[+0-9()\-.\s]*$/, { message: 'Phone contains invalid characters' }) phone?: string;
  @IsOptional() @IsString() @Length(0, 128)  jobTitle?: string;
  @IsOptional() @IsString() @Length(0, 256)  address?: string;
  @IsOptional() @IsString() @Length(0, 96)   city?: string;
  @IsOptional() @IsString() @Length(0, 96)   state?: string;
  @IsOptional() @IsString() @Length(0, 96)   country?: string;
  @IsOptional() @IsString() @Length(0, 32)   postalCode?: string;
  @IsOptional() @IsString() @Length(0, 64)   timeZone?: string;
}

class ResetPasswordDto {
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  password!: string;
}

class SetLevelDto {
  @IsIn(['BUSINESS_OWNER', 'BUSINESS_USER']) level!: 'BUSINESS_OWNER' | 'BUSINESS_USER';
}

class SetCapabilitiesDto {
  @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) capabilities!: string[];
}

class SetBusinessDto {
  @IsOptional() @IsString() businessId?: string | null;
}

class SetPlatformAdminDto {
  @IsBoolean() enabled!: boolean;
}

/**
 * People, scoped to a business.
 *
 * Every route resolves its scope in the service. A user id belonging to
 * another business produces a 404 from `assertUserInScope`, so guessing ids
 * yields nothing.
 */
@Controller('users')
@UseGuards(JwtAuthGuard, CapabilitiesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // ── Self ──────────────────────────────────────────────────────────────────
  // Declared before ':userId' routes so they are not swallowed by the param.

  @Get('me/mfa-status')
  async myMfaStatus(@CurrentUser() u: JwtPayload) {
    return { success: true, data: await this.usersService.getMfaStatus(u.sub) };
  }

  // ── Platform admins ───────────────────────────────────────────────────────

  @Get('platform-admins')
  async listPlatformAdmins(@Actor() actor: ActorContext) {
    return { success: true, data: await this.usersService.listPlatformAdmins(actor) };
  }

  @Get('find')
  async find(@Actor() actor: ActorContext, @Query('email') email: string) {
    if (!email) return { success: false, message: 'email is required' };
    return { success: true, data: await this.usersService.findUserByEmail(actor, email) };
  }

  @Patch(':userId/platform-admin')
  async setPlatformAdmin(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body() dto: SetPlatformAdminDto,
  ) {
    return { success: true, data: await this.usersService.setPlatformAdmin(actor, userId, dto.enabled) };
  }

  // ── Business members ──────────────────────────────────────────────────────

  @Get()
  @RequireCapability(CAP.USERS_VIEW)
  async list(@Actor() actor: ActorContext, @Query('businessId') businessId?: string) {
    return { success: true, data: await this.usersService.listMembers(actor, businessId) };
  }

  @Patch(':userId')
  @RequireCapability(CAP.USERS_MANAGE)
  async updateProfile(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body() dto: UpdateProfileDto,
  ) {
    return { success: true, data: await this.usersService.updateProfile(actor, userId, dto) };
  }

  @Post(':userId/reset-password')
  @RequireCapability(CAP.USERS_MANAGE)
  async resetPassword(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return { success: true, data: await this.usersService.resetPassword(actor, userId, dto.password) };
  }

  @Patch(':userId/suspend')
  @RequireCapability(CAP.USERS_MANAGE)
  async suspend(@Actor() actor: ActorContext, @Param('userId') userId: string) {
    return { success: true, data: await this.usersService.suspend(actor, userId) };
  }

  @Patch(':userId/activate')
  @RequireCapability(CAP.USERS_MANAGE)
  async activate(@Actor() actor: ActorContext, @Param('userId') userId: string) {
    return { success: true, data: await this.usersService.activate(actor, userId) };
  }

  /** Promote/demote between the two business levels. */
  @Patch(':userId/level')
  @RequireCapability(CAP.USERS_MANAGE)
  async setLevel(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body() dto: SetLevelDto,
  ) {
    return { success: true, data: await this.usersService.setLevel(actor, userId, dto.level) };
  }

  @Patch(':userId/capabilities')
  @RequireCapability(CAP.USERS_MANAGE)
  async setCapabilities(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body() dto: SetCapabilitiesDto,
  ) {
    return { success: true, data: await this.usersService.setCapabilities(actor, userId, dto.capabilities) };
  }

  /** Move someone into another business. Platform Admin only. */
  @Patch(':userId/business')
  @RequireCapability(CAP.USERS_MANAGE)
  async setBusiness(
    @Actor() actor: ActorContext,
    @Param('userId') userId: string,
    @Body() dto: SetBusinessDto,
  ) {
    return { success: true, data: await this.usersService.setBusiness(actor, userId, dto.businessId ?? null) };
  }

  @Post(':userId/mfa/reset')
  @RequireCapability(CAP.USERS_MANAGE)
  async resetMfa(@Actor() actor: ActorContext, @Param('userId') userId: string) {
    return { success: true, data: await this.usersService.resetMfa(actor, userId) };
  }

  @Delete(':userId')
  @RequireCapability(CAP.USERS_MANAGE)
  async remove(@Actor() actor: ActorContext, @Param('userId') userId: string) {
    return { success: true, data: await this.usersService.remove(actor, userId) };
  }
}
