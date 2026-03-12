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
  ) {}

  async issueToken(
    tenantId: string,
    userId: string,
    dto: IssueLauncherTokenDto,
    actorIp?: string,
  ) {
    if (!dto.endpointId && !dto.adHocRustdeskId) {
      throw new BadRequestException('Either endpointId or adHocRustdeskId is required');
    }

    let targetRustdeskId = dto.adHocRustdeskId ?? null;
    let targetEndpointId = dto.endpointId ?? null;

    if (dto.endpointId) {
      const endpoint = await this.prisma.endpoint.findFirst({
        where: { id: dto.endpointId, tenantId },
        include: { rustdeskNode: { select: { rustdeskId: true } } },
      });
      if (!endpoint) throw new NotFoundException(`Endpoint ${dto.endpointId} not found`);
      if (!endpoint.rustdeskNode?.rustdeskId) {
        throw new BadRequestException('Endpoint has no RustDesk ID assigned');
      }
      targetRustdeskId = endpoint.rustdeskNode.rustdeskId;
    }

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
      actorId: userId,
      actorIp,
      action: 'LAUNCHER_TOKEN_ISSUED',
      resource: 'launcher_token',
      resourceId: record.id,
      meta: { targetRustdeskId, targetEndpointId },
    });

    const apiUrl = this.config.get<string>('PUBLIC_API_URL') ?? 'http://localhost:3001';
    const deepLink = `reboot-remote://launch?token=${signedToken}&api=${encodeURIComponent(apiUrl)}`;

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

  async revokeToken(tenantId: string, tokenId: string, actorId: string) {
    const record = await this.prisma.launcherToken.findFirst({
      where: { id: tokenId, tenantId },
    });
    if (!record) throw new NotFoundException('Token not found');

    await this.prisma.launcherToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });

    return { revoked: true };
  }
}
