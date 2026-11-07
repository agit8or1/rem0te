import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { PRE_CLIENT_STATUSES } from '../sessions/session-state';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { RustdeskService } from '../common/rustdesk.service';
import { IssueLauncherTokenDto } from './dto/launcher.dto';
import { EndpointsService } from '../endpoints/endpoints.service';
import { QuickConnectService } from '../quick-connect/quick-connect.service';
import { SessionEventsService } from '../sessions/session-events.service';
import { PublicUrlService } from '../platform/public-url.service';

interface LauncherTokenPayload {
  sub: string;           // userId
  tenantId: string;
  sessionId?: string;
  targetEndpointId?: string;
  targetRustdeskId?: string;
  /** Business the token was minted in (signed, so not caller-controlled at redemption). */
  businessId?: string;
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
    private readonly rustdesk: RustdeskService,
    private readonly endpoints: EndpointsService,
    private readonly quickConnect: QuickConnectService,
    private readonly sessionEvents: SessionEventsService,
    private readonly urls: PublicUrlService,
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
      // The same decision as every other way of connecting: business scope
      // alone let a Business User with no grant on this computer launch it.
      if (!(await this.endpoints.canConnect(actor, dto.endpointId))) {
        throw new NotFoundException('Computer not found');
      }
      const endpoint = await this.prisma.endpoint.findUnique({
        where: { id: dto.endpointId },
        include: { rustdeskNode: { select: { rustdeskId: true } } },
      });
      if (!endpoint?.rustdeskNode?.rustdeskId) {
        throw new BadRequestException('That computer has no RustDesk ID assigned');
      }
      targetRustdeskId = endpoint.rustdeskNode.rustdeskId;
    } else if (dto.adHocRustdeskId) {
      // Ad-hoc targets are Quick Connect, which has its own three-way gate:
      // platform switch, business switch, and the capability. Checking only
      // the capability here let a launcher token bypass both switches.
      await this.quickConnect.assertUsable(actor);
    }

    // A session id travels into the token and is written to when the token
    // is redeemed, so it is bound here to exactly one session: in the
    // caller's business, run by the caller, still before its client opened,
    // and for the same target the token launches. Until 0.19.12 only the
    // business was checked, so a token could be pointed at a colleague's
    // session (or a closed one) and its redemption written into it.
    if (dto.sessionId) {
      const scope = this.acl.resolveScope(actor);
      const session = await this.prisma.supportSession.findFirst({
        where: {
          id: dto.sessionId,
          technicianId: actor.userId,
          status: { in: PRE_CLIENT_STATUSES },
          ...(scope ? { customerId: scope } : {}),
          ...(targetEndpointId
            ? { endpointId: targetEndpointId }
            : { isAdHoc: true, adHocRustdeskId: dto.adHocRustdeskId }),
        },
        select: { id: true },
      });
      if (!session) throw new NotFoundException('Session not found');
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
      ...(actor.businessId ? { businessId: actor.businessId } : {}),
    };

    const launcherSecret = this.config.get<string>('LAUNCHER_TOKEN_SECRET');
    const signedToken = await this.jwtService.signAsync(payload, {
      secret: launcherSecret,
      expiresIn: this.tokenTtlSeconds,
    });

    // Persist token record.
    //
    // The column holds a SHA-256 of the token, not the token: it is a bearer
    // credential for a specific machine, and every other one in this system
    // (claim tokens, connection grants, API keys) is stored hashed. Anything
    // that could read the table could otherwise replay a live one.
    const record = await this.prisma.launcherToken.create({
      data: {
        tenantId,
        userId,
        token: createHash('sha256').update(signedToken).digest('hex'),
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

    const apiUrl = this.urls.api();
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

    const record = await this.prisma.launcherToken.findUnique({
      where: { token: createHash('sha256').update(rawToken).digest('hex') },
    });
    if (!record) throw new UnauthorizedException('Token not found');
    if (record.revokedAt) throw new UnauthorizedException('Token has been revoked');
    if (record.usedAt) throw new UnauthorizedException('Token has already been used');
    if (record.expiresAt < new Date()) throw new UnauthorizedException('Token has expired');

    // Re-run authorization NOW. The token was minted up to two minutes ago,
    // and in that window the user may have been suspended, offboarded, had a
    // technician assignment revoked or expire, or moved outside an access
    // schedule. Possession of a once-valid token is not authority.
    const authorized = await this.recheckAuthorization(record, payload);
    if (!authorized.ok) {
      await this.prisma.launcherToken.updateMany({
        where: { id: record.id, usedAt: null }, data: { revokedAt: new Date() },
      });
      await this.audit.log({
        tenantId: record.tenantId, actorId: record.userId, actorIp: clientIp,
        action: 'CONNECTION_GRANT_DENIED', resource: 'launcher_token', resourceId: record.id,
        meta: { reason: authorized.reason },
      });
      throw new UnauthorizedException('Authorization is no longer valid for this connection');
    }

    // Mark as used, and let the database decide who got there first.
    //
    // This was a read, a test of `usedAt`, and then a write: two redemptions of
    // the same token arriving together both passed the test before either
    // wrote, so "single-use" held only when nobody raced it. The conditional
    // update is the check.
    const claimed = await this.prisma.launcherToken.updateMany({
      where: { id: record.id, usedAt: null, revokedAt: null },
      data: { usedAt: new Date() },
    });
    if (claimed.count === 0) throw new UnauthorizedException('Token has already been used');

    // Record that the client opened.
    //
    // The launcher used to POST this to /sessions/:id/events with its launcher
    // token as a bearer credential — which could never work: that route is
    // behind JwtAuthGuard and a launcher token is signed with a different
    // secret entirely. The call was fire-and-forget, so it failed silently and
    // the session simply never left PENDING.
    //
    // Redeeming the token IS the client opening, so the server records it here
    // rather than asking the client to report something we already observed.
    // Redeeming the token is the launcher ACKNOWLEDGING the launch — the one
    // thing the server observes directly. It used to be recorded as
    // CLIENT_OPENED with a start time, i.e. as a session having begun, before
    // the launcher had even spawned RustDesk.
    if (record.supportSessionId) {
      try {
        await this.sessionEvents.record(record.supportSessionId, {
          type: 'launcher_acknowledged', source: 'server', receivedAt: new Date(),
        }, { dedupeKey: `launcher:${record.id}`, metadata: { via: 'launcher_token' } });
      } catch (err) {
        // Telemetry must never block the launch the user is waiting on.
        this.logger.warn(`Could not record launcher acknowledgement for session ${record.supportSessionId}: ${err}`);
      }
    }

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
      rustdeskConfig: await this.rustdeskLaunchConfig(),
    };
  }

  private async recheckAuthorization(
    record: { userId: string; tenantId: string; targetEndpointId: string | null },
    payload: LauncherTokenPayload,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (record.targetEndpointId) {
      const endpoint = await this.prisma.endpoint.findUnique({
        where: { id: record.targetEndpointId }, select: { customerId: true },
      });
      if (!endpoint) return { ok: false, reason: 'endpoint_not_found' };
      const actor = await this.endpoints.liveActor(record.userId, record.tenantId, endpoint.customerId);
      if (!actor) return { ok: false, reason: 'user_inactive' };
      return (await this.endpoints.canConnect(actor, record.targetEndpointId))
        ? { ok: true } : { ok: false, reason: 'no_longer_authorized' };
    }
    // Ad-hoc (Quick Connect): the three switches and the capability, in the
    // business the token was minted in.
    const actor = await this.endpoints.liveActor(record.userId, record.tenantId, payload.businessId ?? null);
    if (!actor) return { ok: false, reason: 'user_inactive' };
    try {
      await this.quickConnect.assertUsable(actor);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'quick_connect_not_usable' };
    }
  }

  /**
   * `host=…,key=…,api=,relay=…,` for `rustdesk --config <arg>` (plain text —
   * RustDesk does not parse a base64 form; see RustdeskServerConfig.configArg).
   *
   * The launcher used to spawn `rustdesk --connect <id>` and nothing else,
   * which quietly assumed the technician's RustDesk was already pointed at
   * this server. A stock client — a fresh install, or an auto-update that
   * replaced a Rem0te-configured build — talks to rustdesk.com's public
   * rendezvous instead, where our IDs do not exist, and RustDesk reports that
   * as "the target device is offline or does not exist". The endpoint looks
   * broken when nothing is wrong with it.
   *
   * Null when the platform has no usable relay host, which the launcher
   * treats as "connect with whatever the client already has".
   */
  private async rustdeskLaunchConfig(): Promise<string | null> {
    return (await this.rustdesk.serverConfig())?.configArg ?? null;
  }

  /** Revoke an outstanding launcher token. Only its issuer's business may. */
  async revokeToken(actor: ActorContext, tokenId: string) {
    const record = await this.prisma.launcherToken.findFirst({
      where: {
        id: tokenId,
        ...(actor.isPlatformAdmin ? {} : {
          OR: [
            { userId: actor.userId },
            { user: { memberships: { some: { customerId: actor.businessId ?? '__none__' } } } },
          ],
        }),
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
