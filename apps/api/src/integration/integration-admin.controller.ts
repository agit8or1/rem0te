import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PlatformAdminGuard } from '../common/guards/platform-admin.guard';
import { Actor } from '../common/decorators/actor.decorator';
import type { ActorContext } from '../rbac/access-control.service';
import { loadTrust } from './peers';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { StepUpService } from '../auth/step-up.service';

const EXT = /^[A-Za-z0-9._:@-]+$/;
class OrgMappingDto {
  @IsString() @Length(1, 64) peerId!: string;
  @IsString() @Length(1, 128) @Matches(EXT) externalOrgId!: string;
  @IsString() @Length(1, 64) businessId!: string;
}
class TechMappingDto {
  @IsString() @Length(1, 64) peerId!: string;
  @IsString() @Length(1, 128) @Matches(EXT) externalOrgId!: string;
  @IsString() @Length(1, 128) @Matches(EXT) externalTechnicianId!: string;
  @IsString() @Length(1, 64) userId!: string;
  @IsOptional() @IsString() note?: string;
}

/**
 * Platform Admin: which ClientSt0r organization is which business, and which
 * ClientSt0r technician is which rem0te user. Explicit rows only — nothing is
 * inferred from names or e-mail addresses. A mapping grants nothing by
 * itself: the user still needs live access to the business and the
 * `integration:ticket_analysis` capability there.
 *
 * Peers themselves (keys, URLs) are not editable here; they live in the
 * root-owned INTEGRATION_PEERS_FILE.
 */
@Controller('admin/integration')
@UseGuards(PlatformAdminGuard)
export class IntegrationAdminController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly stepUp: StepUpService) {}

  @Get('peers')
  peers() {
    const t = loadTrust();
    return {
      success: true,
      data: t ? [...t.peers.values()].map((p) => ({
        id: p.id, audience: p.audience, inferenceHost: p.inferenceUrl.host, eventsHost: p.eventsUrl.host,
        modelProfiles: p.modelProfiles, mtlsPinned: p.clientCertSha256.length > 0,
        requestKeyIds: p.requestKeys.map((k) => k.kid), delegationKeyIds: p.delegationKeys.map((k) => k.kid),
      })) : [],
      configured: !!t,
    };
  }

  @Get('mappings')
  async list(@Query('peerId') peerId?: string) {
    const where = peerId ? { peerId } : {};
    const [orgs, techs] = await Promise.all([
      this.prisma.integrationOrgMapping.findMany({ where: { ...where, revokedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.integrationTechnicianMapping.findMany({ where: { ...where, revokedAt: null }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { success: true, data: { organizations: orgs, technicians: techs } };
  }

  @Post('mappings/organizations')
  async mapOrg(@Req() req: Request, @Actor() actor: ActorContext, @Body() dto: OrgMappingDto) {
    // Mapping decides who acts in which business: same step-up as technician access.
    await this.stepUp.assert(req, 'technicians.manage');
    this.requirePeer(dto.peerId);
    const biz = await this.prisma.customer.findUnique({ where: { id: dto.businessId }, select: { id: true, tenantId: true } });
    if (!biz) throw new NotFoundException('Business not found');
    const row = await this.prisma.integrationOrgMapping.create({
      data: { peerId: dto.peerId, externalOrgId: dto.externalOrgId, customerId: biz.id, tenantId: biz.tenantId, createdById: actor.userId },
    });
    await this.audit.log({ action: 'INTEGRATION_MAPPING_CHANGED', actorId: actor.userId, tenantId: biz.tenantId, customerId: biz.id, resource: 'integration_org_mapping', resourceId: row.id, meta: { op: 'create', peer: dto.peerId, org: dto.externalOrgId } });
    return { success: true, data: row };
  }

  @Post('mappings/technicians')
  async mapTech(@Req() req: Request, @Actor() actor: ActorContext, @Body() dto: TechMappingDto) {
    // Mapping decides who acts in which business: same step-up as technician access.
    await this.stepUp.assert(req, 'technicians.manage');
    this.requirePeer(dto.peerId);
    const org = await this.prisma.integrationOrgMapping.findUnique({ where: { peerId_externalOrgId: { peerId: dto.peerId, externalOrgId: dto.externalOrgId } } });
    if (!org || org.revokedAt) throw new BadRequestException('Map the organization first');
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found');
    const row = await this.prisma.integrationTechnicianMapping.create({
      data: { peerId: dto.peerId, externalOrgId: dto.externalOrgId, externalTechnicianId: dto.externalTechnicianId, userId: user.id, createdById: actor.userId },
    });
    await this.audit.log({ action: 'INTEGRATION_MAPPING_CHANGED', actorId: actor.userId, tenantId: org.tenantId, customerId: org.customerId, resource: 'integration_technician_mapping', resourceId: row.id, meta: { op: 'create', peer: dto.peerId, org: dto.externalOrgId, technician: dto.externalTechnicianId, userId: user.id } });
    return { success: true, data: row };
  }

  @Delete('mappings/organizations/:id')
  async unmapOrg(@Req() req: Request, @Actor() actor: ActorContext, @Param('id') id: string) {
    // Mapping decides who acts in which business: same step-up as technician access.
    await this.stepUp.assert(req, 'technicians.manage');
    const row = await this.prisma.integrationOrgMapping.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    // Deleted, not just flagged: the unique (peer, org) and (peer, business)
    // keys must be free for a corrected mapping.
    await this.prisma.integrationOrgMapping.delete({ where: { id } });
    await this.prisma.integrationTechnicianMapping.deleteMany({ where: { peerId: row.peerId, externalOrgId: row.externalOrgId } });
    await this.audit.log({ action: 'INTEGRATION_MAPPING_CHANGED', actorId: actor.userId, tenantId: row.tenantId, customerId: row.customerId, resource: 'integration_org_mapping', resourceId: id, meta: { op: 'delete', peer: row.peerId, org: row.externalOrgId } });
    return { success: true };
  }

  @Delete('mappings/technicians/:id')
  async unmapTech(@Req() req: Request, @Actor() actor: ActorContext, @Param('id') id: string) {
    // Mapping decides who acts in which business: same step-up as technician access.
    await this.stepUp.assert(req, 'technicians.manage');
    const row = await this.prisma.integrationTechnicianMapping.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    await this.prisma.integrationTechnicianMapping.delete({ where: { id } });
    await this.audit.log({ action: 'INTEGRATION_MAPPING_CHANGED', actorId: actor.userId, resource: 'integration_technician_mapping', resourceId: id, meta: { op: 'delete', peer: row.peerId, org: row.externalOrgId, technician: row.externalTechnicianId } });
    return { success: true };
  }

  private requirePeer(peerId: string) {
    if (!loadTrust()?.peers.has(peerId)) throw new BadRequestException('Unknown peer (not in INTEGRATION_PEERS_FILE)');
  }
}
