import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('status')
  async getStatus(@CurrentUser() user: JwtPayload) {
    return { success: true, data: await this.adminService.getStatus(user) };
  }

  @Get('unassigned-devices')
  async listUnassigned(@CurrentUser() user: JwtPayload) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin access required');
    return { success: true, data: await this.adminService.getUnassignedDevices() };
  }

  @Post('unassigned-devices/:id/assign')
  @HttpCode(HttpStatus.OK)
  async assignDevice(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body('tenantId') tenantId: string,
  ) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin access required');
    return { success: true, data: await this.adminService.assignDevice(id, tenantId) };
  }
}
