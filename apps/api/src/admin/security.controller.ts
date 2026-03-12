import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, ForbiddenException } from '@nestjs/common';
import { SecurityService } from './security.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';

@Controller('admin/security')
@UseGuards(JwtAuthGuard)
export class SecurityController {
  constructor(private readonly securityService: SecurityService) {}

  private assertAdmin(user: JwtPayload) {
    if (!user.isPlatformAdmin) throw new ForbiddenException('Platform admin access required');
  }

  @Get('config')
  async getConfig(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.getConfig() };
  }

  @Patch('config')
  async updateConfig(@CurrentUser() user: JwtPayload, @Body() body: Record<string, unknown>) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.updateConfig(body as Parameters<SecurityService['updateConfig']>[0]) };
  }

  @Get('fail2ban')
  async getFail2ban(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.getFail2ban() };
  }

  @Post('fail2ban/unban')
  async unbanIp(@CurrentUser() user: JwtPayload, @Body() body: { jail: string; ip: string }) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.unbanIp(body.jail, body.ip) };
  }

  @Post('fail2ban/ban')
  async banIp(@CurrentUser() user: JwtPayload, @Body() body: { jail: string; ip: string }) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.banIp(body.jail, body.ip) };
  }

  @Get('fail2ban/ignore')
  async getIgnoreList(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.getIgnoreList() };
  }

  @Post('fail2ban/ignore')
  async addIgnoreIp(@CurrentUser() user: JwtPayload, @Body() body: { ip: string }) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.addIgnoreIp(body.ip) };
  }

  @Delete('fail2ban/ignore/:ip')
  async removeIgnoreIp(@CurrentUser() user: JwtPayload, @Param('ip') ip: string) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.removeIgnoreIp(ip) };
  }

  @Get('fail2ban/jail/:jail/config')
  async getJailConfig(@CurrentUser() user: JwtPayload, @Param('jail') jail: string) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.getJailConfig(jail) };
  }

  @Patch('fail2ban/jail/:jail/config')
  async updateJailConfig(@CurrentUser() user: JwtPayload, @Param('jail') jail: string, @Body() body: { bantime?: number; findtime?: number; maxretry?: number }) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.updateJailConfig(jail, body.bantime, body.findtime, body.maxretry) };
  }

  @Post('fail2ban/install')
  async installFail2ban(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.installFail2ban() };
  }

  @Get('os-updates')
  async getOsUpdates(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.getOsUpdates() };
  }

  @Post('os-updates/run')
  runOsUpdate(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: this.securityService.runOsUpdate() };
  }

  @Get('os-updates/status')
  getOsUpdateStatus(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: this.securityService.getOsUpdateStatus() };
  }

  @Get('audit')
  async runAudit(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.runAudit() };
  }

  @Post('audit/fix')
  async runAuditFix(@CurrentUser() user: JwtPayload, @Body() body: { force?: boolean }) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.runAuditFix(body.force ?? false) };
  }

  @Get('tls')
  async getTls(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.getTls() };
  }

  @Post('tls/renew')
  async renewTls(@CurrentUser() user: JwtPayload) {
    this.assertAdmin(user);
    return { success: true, data: await this.securityService.renewTls() };
  }
}
