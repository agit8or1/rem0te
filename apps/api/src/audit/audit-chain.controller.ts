import { Controller, ForbiddenException, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { AuditChainService } from './audit-chain.service';

/**
 * Audit chain integrity (v0.28): platform-level, so Platform Admins and
 * technicians:manage holders only (outside a technician context). Reading it
 * proves nothing on its own — a compromised portal can answer anything here.
 * The proof is `audit verify --export` against the copy held off the host.
 */
@Controller('audit/integrity')
@UseGuards(JwtAuthGuard)
export class AuditChainController {
  constructor(private readonly chain: AuditChainService) {}

  private check(a: ActorContext) {
    if (!(a.isPlatformAdmin || (!a.technician && (a.platformPermissions ?? []).includes('technicians:manage' as never)))) {
      throw new ForbiddenException({ code: 'NOT_ALLOWED', message: 'Audit integrity is shown to Platform Admins and technician managers.' });
    }
  }

  @Get()
  async status(@Actor() a: ActorContext) { this.check(a); return { success: true, data: await this.chain.status() }; }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Actor() a: ActorContext) {
    this.check(a);
    const r = await this.chain.verify();
    return { success: true, data: { ...r, problems: r.problems.slice(0, 50) } };
  }
}
