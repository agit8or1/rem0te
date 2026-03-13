import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import type { RoleType } from '@prisma/client';

class InviteUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  roleId!: string;
}

class ChangeRoleDto {
  @IsString()
  roleId!: string;
}

class UpdateProfileDto {
  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

class ResetPasswordDto {
  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  password!: string;
}

@Controller('users')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermissions('users:read')
  list(@CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.listMembers(user.tenantId);
  }

  @Post('invite')
  @RequirePermissions('users:write')
  invite(@CurrentUser() user: JwtPayload, @Body() dto: InviteUserDto) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.invite(user.tenantId, user.sub, dto.email, dto.roleId);
  }

  @Patch(':userId')
  @RequirePermissions('users:write')
  updateProfile(
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.updateProfile(
      user.tenantId, userId, user.sub, user.roleType as RoleType | null, dto,
    );
  }

  @Post(':userId/reset-password')
  @RequirePermissions('users:write')
  resetPassword(
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ResetPasswordDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.resetPassword(
      user.tenantId, userId, user.sub, user.roleType as RoleType | null, dto.password,
    );
  }

  @Patch(':userId/suspend')
  @RequirePermissions('users:write')
  suspend(@Param('userId') userId: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.suspend(
      user.tenantId, userId, user.sub, user.roleType as RoleType | null,
    );
  }

  @Patch(':userId/activate')
  @RequirePermissions('users:write')
  activate(@Param('userId') userId: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.activate(
      user.tenantId, userId, user.sub, user.roleType as RoleType | null,
    );
  }

  @Patch(':userId/role')
  @RequirePermissions('roles:write')
  changeRole(
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
    @Body() dto: ChangeRoleDto,
  ) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.changeRole(
      user.tenantId, userId, dto.roleId, user.sub, user.roleType as RoleType | null,
    );
  }

  @Delete(':userId')
  @RequirePermissions('users:write')
  remove(@Param('userId') userId: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.removeFromTenant(
      user.tenantId, userId, user.sub, user.roleType as RoleType | null,
    );
  }

  @Post(':userId/mfa/reset')
  @RequirePermissions('users:write')
  resetMfa(@Param('userId') userId: string, @CurrentUser() user: JwtPayload) {
    if (!user.tenantId) return { success: false, message: 'No tenant context' };
    return this.usersService.resetMfa(
      user.tenantId, userId, user.sub, user.roleType as RoleType | null,
    );
  }

  @Get('me/mfa-status')
  getMfaStatus(@CurrentUser() user: JwtPayload) {
    return this.usersService.getMfaStatus(user.sub);
  }

  // Platform admin management — restricted to isPlatformAdmin users

  @Get('platform-admins')
  listPlatformAdmins(@CurrentUser() user: JwtPayload) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin access required');
    return this.usersService.listPlatformAdmins().then((data) => ({ success: true, data }));
  }

  @Get('find')
  findByEmail(@CurrentUser() user: JwtPayload, @Query('email') email: string) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin access required');
    if (!email) return { success: false, message: 'email query param required' };
    return this.usersService.findUserByEmail(email).then((data) => ({ success: true, data }));
  }

  @Patch(':userId/platform-admin')
  setPlatformAdmin(
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
    @Body() body: { enabled: boolean },
  ) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin access required');
    return this.usersService
      .setPlatformAdmin(userId, body.enabled, user.sub)
      .then((data) => ({ success: true, data }));
  }
}
