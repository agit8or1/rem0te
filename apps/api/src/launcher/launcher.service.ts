import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { IssueLauncherTokenDto } from './dto/launcher.dto';

interface LauncherTokenPayload {
  sub: string;           // userId
  tenantId: string;
  sessionId?: string;
  targetEndpointId?: string;
  targetRustdeskId?: string;
  type: 'launcher';
}

@Injectable()
export class LauncherService {
  private readonly logger = new Logger(LauncherService.name);
  private readonly tokenTtlSeconds = 120;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly acl: AccessControlService,
  ) {}

  /**
   * Mint a short-lived deep-link token for the desktop launcher.
   *
   * A launcher token is a bearer credential for a specific machine, so the
   * business check has to happen here too — not only on the route that
   * eventually reveals the password.
   */
  async issueToken(actor: ActorContext, dto: IssueLauncherTokenDto) {
    if (!dto.endpointId && !dto.adHocRustdeskId) {
      throw new BadRequestException('Either endpointId or adHocRustdeskId is required');
    }
    this.acl.assertCapability(actor, CAP.COMPUTERS_CONNECT);

    let targetRustdeskId = dto.adHocRustdeskId ?? null;
    const targetEndpointId = dto.endpointId ?? null;

    if (dto.endpointId) {
      // Confirms the computer is inside the caller's business before anything
      // else is read from it.
      await this.acl.assertEndpointInScope(actor, dto.endpointId);
      const endpoint = await this.prisma.endpoint.findUnique({
        where: { id: dto.endpointId },
        include: { rustdeskNode: { select: { rustdeskId: true } } },
      });
      if (!endpoint?.rustdeskNode?.rustdeskId) {
        throw new BadRequestException('That computer has no RustDesk ID assigned');
      }
      targetRustdeskId = endpoint.rustdeskNode.rustdeskId;
    } else if (dto.adHocRustdeskId) {
      // Ad-hoc targets are Quick Connect, which has its own three-way gate.
      this.acl.assertCapability(actor, CAP.QUICK_CONNECT);
    }

    const tenantId = actor.tenantId;
    if (!tenantId) throw new BadRequestException('No platform context');
    const userId = actor.userId;

    const expiresAt = new Date(Date.now() + this.tokenTtlSeconds * 1000);

    // Build and sign the launcher JWT
    const payload: LauncherTokenPayload = {
      sub: userId,
      tenantId,
      type: 'launcher',
      ...(targetEndpointId ? { targetEndpointId } : {}),
      ...(targetRustdeskId ? { targetRustdeskId } : {}),
      ...(dto.sessionId ? { sessionId: dto.sessionId } : {}),
    };

    const launcherSecret = this.config.get<string>('LAUNCHER_TOKEN_SECRET');
    const signedToken = await this.jwtService.signAsync(payload, {
      secret: launcherSecret,
      expiresIn: this.tokenTtlSeconds,
    });

    // Persist token record
    const record = await this.prisma.launcherToken.create({
      data: {
        tenantId,
        userId,
        token: signedToken,
        expiresAt,
        targetEndpointId,
        targetRustdeskId,
        supportSessionId: dto.sessionId ?? null,
      },
    });

    await this.audit.log({
      tenantId,
      customerId: actor.businessId ?? undefined,
      actorId: userId,
      actorIp: actor.ip,
      action: 'LAUNCHER_TOKEN_ISSUED',
      resource: 'launcher_token',
      resourceId: record.id,
      meta: { targetRustdeskId, targetEndpointId },
    });

    const apiUrl = this.config.get<string>('PUBLIC_API_URL') ?? 'http://localhost:3001';
    // Use fragment (#) instead of query string — fragments are not sent to servers or logged by proxies
    const deepLink = `reboot-remote://launch#token=${signedToken}&api=${encodeURIComponent(apiUrl)}`;

    return { token: signedToken, deepLink, expiresAt };
  }

  async validateToken(rawToken: string, clientIp?: string) {
    const launcherSecret = this.config.get<string>('LAUNCHER_TOKEN_SECRET');

    let payload: LauncherTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<LauncherTokenPayload>(rawToken, {
        secret: launcherSecret,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired launcher token');
    }

    if (payload.type !== 'launcher') {
      throw new UnauthorizedException('Invalid token type');
    }

    const record = await this.prisma.launcherToken.findUnique({ where: { token: rawToken } });
    if (!record) throw new UnauthorizedException('Token not found');
    if (record.revokedAt) throw new UnauthorizedException('Token has been revoked');
    if (record.usedAt) throw new UnauthorizedException('Token has already been used');
    if (record.expiresAt < new Date()) throw new UnauthorizedException('Token has expired');

    // Mark as used (single-use)
    await this.prisma.launcherToken.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    });

    await this.audit.log({
      tenantId: record.tenantId,
      actorId: record.userId,
      actorIp: clientIp,
      action: 'LAUNCHER_TOKEN_USED',
      resource: 'launcher_token',
      resourceId: record.id,
      meta: { targetRustdeskId: record.targetRustdeskId },
    });

    return {
      userId: record.userId,
      tenantId: record.tenantId,
      targetRustdeskId: record.targetRustdeskId,
      targetEndpointId: record.targetEndpointId,
      sessionId: record.supportSessionId,
    };
  }

  /** Revoke an outstanding launcher token. Only its issuer's business may. */
  async revokeToken(actor: ActorContext, tokenId: string) {
    const record = await this.prisma.launcherToken.findFirst({
      where: {
        id: tokenId,
        ...(actor.isPlatformAdmin ? {} : { user: { memberships: { some: { customerId: actor.businessId ?? '__none__' } } } }),
      },
    });
    if (!record) throw new NotFoundException('Token not found');

    await this.prisma.launcherToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });

    return { revoked: true };
  }
}
