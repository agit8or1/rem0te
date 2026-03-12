import { Controller, Get, Post, Body, UseGuards, ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import { RoleType, SessionStatus } from '@prisma/client';

@Controller('portal')
@UseGuards(JwtAuthGuard)
export class PortalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  private assertCustomer(user: JwtPayload) {
    if (user.roleType !== RoleType.CUSTOMER || !user.customerId || !user.tenantId) {
      throw new ForbiddenException('Customer portal access only');
    }
  }

  @Get('me')
  async getMe(@CurrentUser() user: JwtPayload) {
    this.assertCustomer(user);
    const customer = await this.prisma.customer.findFirst({
      where: { id: user.customerId!, tenantId: user.tenantId! },
      select: { id: true, name: true, email: true },
    });
    return { success: true, data: { user, customer } };
  }

  @Get('endpoints')
  async getEndpoints(@CurrentUser() user: JwtPayload) {
    this.assertCustomer(user);
    const endpoints = await this.prisma.endpoint.findMany({
      where: { tenantId: user.tenantId!, customerId: user.customerId! },
      include: { rustdeskNode: { select: { rustdeskId: true, lastSeenAt: true } }, tags: true },
      orderBy: { name: 'asc' },
    });
    return { success: true, data: endpoints };
  }

  @Get('sessions')
  async getSessions(@CurrentUser() user: JwtPayload) {
    this.assertCustomer(user);
    // Get all sessions for endpoints belonging to this customer
    const sessions = await this.prisma.supportSession.findMany({
      where: {
        tenantId: user.tenantId!,
        endpoint: { customerId: user.customerId! },
      },
      include: {
        technician: { select: { id: true, firstName: true, lastName: true } },
        endpoint: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { success: true, data: sessions };
  }

  @Post('request-support')
  async requestSupport(
    @CurrentUser() user: JwtPayload,
    @Body() dto: { endpointId?: string; issueDescription?: string; contactName?: string; contactEmail?: string },
  ) {
    this.assertCustomer(user);

    // Verify endpoint belongs to their customer (if provided)
    if (dto.endpointId) {
      const ep = await this.prisma.endpoint.findFirst({
        where: { id: dto.endpointId, tenantId: user.tenantId!, customerId: user.customerId! },
      });
      if (!ep) throw new ForbiddenException('Endpoint not found or not accessible');
    }

    // Find the tenant owner to assign as "technician" placeholder (will be reassigned)
    const ownerMembership = await this.prisma.membership.findFirst({
      where: { tenantId: user.tenantId!, role: { type: RoleType.TENANT_OWNER } },
      include: { user: true },
    });
    if (!ownerMembership) throw new ForbiddenException('No technician available');

    const session = await this.prisma.supportSession.create({
      data: {
        tenantId: user.tenantId!,
        technicianId: ownerMembership.userId,
        endpointId: dto.endpointId ?? null,
        contactName: dto.contactName ?? null,
        contactEmail: dto.contactEmail ?? null,
        issueDescription: dto.issueDescription ?? null,
        status: 'PENDING',
      },
    });

    return { success: true, data: session };
  }

  @Post('connect')
  async connectSelf(
    @CurrentUser() user: JwtPayload,
    @Body() dto: { endpointId: string },
  ) {
    this.assertCustomer(user);

    // Verify endpoint belongs to this customer and get its RustDesk ID
    const endpoint = await this.prisma.endpoint.findFirst({
      where: { id: dto.endpointId, tenantId: user.tenantId!, customerId: user.customerId! },
      include: { rustdeskNode: { select: { rustdeskId: true } } },
    });
    if (!endpoint) throw new NotFoundException('Endpoint not found or not accessible');

    const rustdeskId = endpoint.rustdeskNode?.rustdeskId ?? null;
    if (!rustdeskId) throw new NotFoundException('This endpoint has no RustDesk ID — make sure the client is installed and enrolled');

    // Log the self-service connection as a session for audit trail
    const session = await this.prisma.supportSession.create({
      data: {
        tenantId: user.tenantId!,
        technicianId: user.sub,   // customer initiated — record them as actor
        endpointId: endpoint.id,
        contactName: null,
        contactEmail: null,
        issueDescription: 'Self-service remote access',
        status: SessionStatus.LAUNCH_REQUESTED,
      },
    });

    return {
      success: true,
      data: {
        sessionId: session.id,
        rustdeskId,
        launchUrl: `rustdesk://connection/new/${rustdeskId}`,
      },
    };
  }
}
