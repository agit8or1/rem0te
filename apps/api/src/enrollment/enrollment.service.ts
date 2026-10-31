import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger, UnauthorizedException } from '@nestjs/common';
import { randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'crypto';
import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ConfigService } from '@nestjs/config';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { CreateClaimTokenDto, ClaimEndpointDto } from './dto/enrollment.dto';
import { EndpointInventoryService } from '../endpoint-inventory/endpoint-inventory.service';
import { CANDIDATE_LIVE_MS, CANDIDATE_SETTLE_MS } from './device-secret';
import { queryHbbsOnline } from './hbbs-presence';

const execFileAsync = promisify(execFile);

@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);
  private readonly tokenTtlHours = 24;
  private readonly encKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly acl: AccessControlService,
    private readonly inventory: EndpointInventoryService,
  ) {
    const rawKey = this.config.get<string>('ENCRYPTION_KEY');
    if (!rawKey || !/^[0-9a-fA-F]{64}$/.test(rawKey) || rawKey.toLowerCase() === '0'.repeat(64)) {
      throw new Error('ENCRYPTION_KEY is missing or invalid — refusing to start. Set a 64-hex-char key.');
    }
    this.encKey = Buffer.from(rawKey, 'hex');
  }

  private encryptPassword(text: string): string {
    // 12 bytes is the GCM standard nonce length. The IV is stored with each
    // record, so anything written when this was 16 still decrypts.
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encKey, iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  }

  /**
   * Mint a managed-device enrollment token.
   *
   * The business the device will land in is decided here, from the caller's
   * scope — never by the machine that later redeems the token. Everything the
   * token carries (business, access mode, assigned users) is validated now,
   * so a device can only ever enroll itself where an authorised person said
   * it could.
   */
  async createClaimToken(actor: ActorContext, dto: CreateClaimTokenDto & { businessId?: string }) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_ADD);

    const businessId = this.acl.requireScope(actor, dto.businessId ?? dto.customerId);
    const business = await this.prisma.customer.findFirst({
      where: { id: businessId, isArchived: false },
      select: { id: true, tenantId: true, name: true },
    });
    if (!business) throw new NotFoundException('Business not found');

    if (dto.endpointId) {
      // Re-enrolling an existing computer: it must already be in this business.
      await this.acl.assertEndpointInScope(actor, dto.endpointId);
    }

    // Every assigned user must belong to the SAME business as the device.
    // Without this check a token could hand a stranger standing access to a
    // machine the moment it enrolls.
    let assignedUserIds: string[] = [];
    if (dto.assignedUserIds && dto.assignedUserIds.length > 0) {
      const memberships = await this.prisma.membership.findMany({
        where: { customerId: businessId, isActive: true, userId: { in: dto.assignedUserIds } },
        select: { userId: true },
      });
      const validIds = new Set(memberships.map((m) => m.userId));
      const missing = dto.assignedUserIds.filter((id) => !validIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          `These users are not active members of ${business.name}: ${missing.join(', ')}`,
        );
      }
      assignedUserIds = dto.assignedUserIds;
    }

    if (dto.endpointGroupId) {
      const group = await this.prisma.endpointGroup.findFirst({
        where: { id: dto.endpointGroupId, tenantId: business.tenantId },
        select: { id: true },
      });
      if (!group) throw new BadRequestException('Unknown computer group');
    }

    const token = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + this.tokenTtlHours * 60 * 60 * 1000);

    const record = await this.prisma.deviceClaimToken.create({
      data: {
        tenantId: business.tenantId,
        token: tokenHash,
        expiresAt,
        endpointId: dto.endpointId ?? null,
        customerName: business.name,
        siteName: dto.siteName ?? null,
        description: dto.description ?? null,
        customerId: businessId,
        accessMode: dto.accessMode ?? 'ASSIGNED_USERS',
        assignedUserIds,
        endpointGroupId: dto.endpointGroupId ?? null,
        createdById: actor.userId,
      },
    });

    await this.audit.log({
      tenantId: business.tenantId,
      customerId: businessId,
      actorId: actor.userId,
      actorIp: actor.ip,
      action: 'CLAIM_TOKEN_CREATED',
      resource: 'device_claim_token',
      resourceId: record.id,
      meta: {
        endpointId: dto.endpointId,
        description: dto.description,
        businessId,
        accessMode: dto.accessMode ?? 'ASSIGNED_USERS',
        assignedUserIds,
      },
    });

    // The raw token is returned once so the caller can build the install URL;
    // only its hash is stored.
    return { ...record, token };
  }

  async listClaimTokens(actor: ActorContext, businessId?: string) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const scope = this.acl.resolveScope(actor, businessId);

    return this.prisma.deviceClaimToken.findMany({
      where: { ...(scope ? { customerId: scope } : {}) },
      include: {
        endpoint: { select: { id: true, name: true, hostname: true } },
        // Enough to show which business a token is bound to, nothing more.
        tenant: { select: { id: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async claimEndpoint(dto: ClaimEndpointDto, claimedByIp?: string) {
    const tokenHash = createHash('sha256').update(dto.token).digest('hex');
    const record = await this.prisma.deviceClaimToken.findUnique({
      where: { token: tokenHash },
    });

    if (!record) throw new NotFoundException('Claim token not found');
    if (record.claimedAt) throw new BadRequestException('Token has already been used');
    if (record.expiresAt < new Date()) throw new BadRequestException('Token has expired');

    // Consume the token before doing anything with it. The checks above read
    // and the write used to come at the very end, so two installers racing
    // the same token both passed and both enrolled. A conditional update is
    // the single-use guarantee; the reads above only pick the error message.
    const consumed = await this.prisma.deviceClaimToken.updateMany({
      where: { id: record.id, claimedAt: null, expiresAt: { gte: new Date() } },
      data: { claimedAt: new Date(), claimedByIp: claimedByIp ?? null },
    });
    if (consumed.count !== 1) throw new BadRequestException('Token has already been used');

    try {
      return await this.claimWithConsumedToken(dto, record, claimedByIp);
    } catch (e) {
      // A claim that failed half-way has enrolled nothing. Hand the token back
      // so the operator is not forced to mint another for a typo-class error.
      await this.prisma.deviceClaimToken.update({
        where: { id: record.id },
        data: { claimedAt: null, claimedByIp: null },
      }).catch(() => { /* the original error is the one worth reporting */ });
      throw e;
    }
  }

  private async claimWithConsumedToken(
    dto: ClaimEndpointDto,
    record: NonNullable<Awaited<ReturnType<PrismaService['deviceClaimToken']['findUnique']>>>,
    claimedByIp: string | undefined,
  ) {
    // Check for duplicate RustDesk ID globally
    const existingNode = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId: dto.rustdeskId },
    });

    // Re-enrolling the very computer this token was minted for. An operator in
    // its business chose this machine, so the claim may rebind its device
    // secret — the recovery path for a node that has none, now that a
    // heartbeat no longer binds one on first sight. Falls through to the
    // update path below, which upserts the node by endpoint.
    const reEnrolling = !!existingNode && !!record.endpointId && existingNode.endpointId === record.endpointId;

    if (existingNode && !reEnrolling) {
      // One message for every refusal: the installer only needs to know it
      // was refused, and distinguishing "another account" from "this one"
      // told a token holder which RustDesk IDs exist on the platform.
      if (existingNode.tenantId) {
        throw new BadRequestException(`RustDesk ID ${dto.rustdeskId} cannot be enrolled with this token`);
      }
      // An unassigned node is a machine that heartbeated in on its own and
      // bound a device secret doing so. Adopting or replacing it means
      // proving that secret — otherwise anyone holding any business's token
      // could pull another machine out of the pending pool by its ID.
      if (
        existingNode.agentSecretHash &&
        (!dto.agentSecret || !this.secretMatches(existingNode.agentSecretHash, dto.agentSecret))
      ) {
        throw new BadRequestException(`RustDesk ID ${dto.rustdeskId} cannot be enrolled with this token`);
      }
      if (!record.endpointId) {
        // Adopt the unassigned node/endpoint into the token's business
        await this.prisma.rustdeskNode.update({
          where: { id: existingNode.id },
          data: {
            tenantId: record.tenantId,
            ...(dto.agentSecret
              ? { agentSecretHash: this.hashSecret(dto.agentSecret), agentSecretSetAt: new Date() }
              : {}),
          },
        });
        await this.prisma.endpoint.update({
          where: { id: existingNode.endpointId },
          data: { tenantId: record.tenantId, status: 'ACTIVE' },
        });
        await this.prisma.deviceClaimToken.update({
          where: { id: record.id },
          data: { endpointId: existingNode.endpointId },
        });
        const endpoint = await this.prisma.endpoint.findUnique({ where: { id: existingNode.endpointId } });
        await this.audit.log({
          tenantId: record.tenantId,
          action: 'ENDPOINT_CLAIMED',
          resource: 'endpoint',
          resourceId: existingNode.endpointId,
          actorIp: claimedByIp,
          meta: { rustdeskId: dto.rustdeskId, hostname: dto.hostname },
        });
        return { endpoint, tenantId: record.tenantId };
      } else {
        // Token has endpointId — delete the unassigned duplicate and proceed with normal token flow
        await this.prisma.rustdeskNode.delete({ where: { id: existingNode.id } });
        await this.prisma.endpoint.delete({ where: { id: existingNode.endpointId } });
      }
    }

    let endpoint = record.endpointId
      ? await this.prisma.endpoint.findUnique({ where: { id: record.endpointId } })
      : null;

    if (endpoint) {
      // Update existing endpoint. Token's binding overrides prior customer/access
      // if this is a re-enrollment against a specific token.
      endpoint = await this.prisma.endpoint.update({
        where: { id: endpoint.id },
        data: {
          hostname: dto.hostname ?? endpoint.hostname,
          platform: dto.platform ?? endpoint.platform,
          osVersion: dto.osVersion ?? endpoint.osVersion,
          lastSeenAt: new Date(),
          isOnline: true,
          status: 'ACTIVE',
          ...(record.customerId ? { customerId: record.customerId } : {}),
          ...(record.endpointGroupId ? { endpointGroupId: record.endpointGroupId } : {}),
          accessMode: record.accessMode,
        },
      });
    } else {
      // Create new endpoint from token+claim context. customerId and
      // endpointGroupId come from the token so the endpoint cannot enroll
      // itself into a different business.
      endpoint = await this.prisma.endpoint.create({
        data: {
          tenantId: record.tenantId,
          customerId: record.customerId ?? null,
          endpointGroupId: record.endpointGroupId ?? null,
          accessMode: record.accessMode,
          name: dto.hostname ?? dto.rustdeskId,
          hostname: dto.hostname ?? null,
          platform: dto.platform ?? null,
          osVersion: dto.osVersion ?? null,
          isManaged: true,
          lastSeenAt: new Date(),
          isOnline: true,
          status: 'ACTIVE',
        },
      });
    }

    const encryptedPassword = dto.password ? this.encryptPassword(dto.password) : undefined;

    // Upsert RustdeskNode — the join between endpoint and RustDesk ID.
    //
    // Claim is the authenticated enrollment path: redeeming a single-use claim
    // token proves the installer was handed out by an operator, so this is the
    // right moment to bind (or rebind) the device secret every later heartbeat
    // is checked against. Re-running the installer therefore re-establishes a
    // machine's identity, which is exactly the recovery path for one enrolled
    // before secrets existed.
    const secretBinding = dto.agentSecret
      ? { agentSecretHash: this.hashSecret(dto.agentSecret), agentSecretSetAt: new Date() }
      : {};
    await this.prisma.rustdeskNode.upsert({
      where: { endpointId: endpoint.id },
      create: {
        tenantId: record.tenantId,
        endpointId: endpoint.id,
        rustdeskId: dto.rustdeskId,
        hostname: dto.hostname ?? null,
        platform: dto.platform ?? null,
        lastSeenAt: new Date(),
        ...secretBinding,
        ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
      },
      update: {
        rustdeskId: dto.rustdeskId,
        hostname: dto.hostname ?? undefined,
        platform: dto.platform ?? undefined,
        lastSeenAt: new Date(),
        ...secretBinding,
        ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
      },
    });

    // Apply user access assignments from the token. The endpoint has no say
    // in this — the assignedUserIds were locked in when the admin minted the
    // token, and were validated at that time to belong to the same tenant.
    if (record.assignedUserIds.length > 0) {
      // Upsert-then-prune so re-enrollment against a new token becomes the new
      // authoritative access list (without churning identical rows).
      const currentAccess = await this.prisma.computerAccess.findMany({
        where: { endpointId: endpoint.id },
        select: { userId: true },
      });
      const currentIds = new Set(currentAccess.map((c) => c.userId));
      const wantIds = new Set(record.assignedUserIds);

      const toAdd = record.assignedUserIds.filter((u) => !currentIds.has(u));
      const toRemove = [...currentIds].filter((u) => !wantIds.has(u));

      if (toAdd.length > 0) {
        await this.prisma.computerAccess.createMany({
          data: toAdd.map((userId) => ({
            tenantId: record.tenantId,
            endpointId: endpoint!.id,
            userId,
            grantedBy: record.createdById ?? null,
          })),
          skipDuplicates: true,
        });
      }
      if (toRemove.length > 0) {
        await this.prisma.computerAccess.deleteMany({
          where: { endpointId: endpoint.id, userId: { in: toRemove } },
        });
      }
    }

    // The token was consumed up front; record what it enrolled.
    await this.prisma.deviceClaimToken.update({
      where: { id: record.id },
      data: { endpointId: endpoint.id },
    });

    await this.audit.log({
      tenantId: record.tenantId,
      action: 'ENDPOINT_CLAIMED',
      resource: 'endpoint',
      resourceId: endpoint.id,
      actorIp: claimedByIp,
      meta: {
        rustdeskId: dto.rustdeskId,
        hostname: dto.hostname,
        customerId: record.customerId,
        accessMode: record.accessMode,
        assignedUsers: record.assignedUserIds.length,
      },
    });

    return { endpoint, tenantId: record.tenantId };
  }

  async heartbeat(dto: {
    rustdeskId: string; hostname?: string; platform?: string; osVersion?: string;
    agentVersion?: string; rustdeskVersion?: string; ipAddress?: string;
    password?: string; agentSecret?: string;
    loggedOnUser?: string; uptimeSeconds?: number; lastBootAt?: string;
    cpuLoadPercent?: number; memoryTotalMb?: number; memoryFreeMb?: number;
    systemDiskTotalMb?: number; systemDiskFreeMb?: number;
  }, remoteIp?: string) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId: dto.rustdeskId },
    });

    // Identity check before anything is read or written. See secretMatches().
    let authenticated = false;
    if (node) {
      if (node.agentSecretHash) {
        if (!dto.agentSecret || !this.secretMatches(node.agentSecretHash, dto.agentSecret)) {
          if (dto.agentSecret) await this.recordCandidateSecret(node.id, node, dto.agentSecret, remoteIp);
          await this.audit.log({
            tenantId: node.tenantId ?? undefined,
            action: 'ENDPOINT_HEARTBEAT_REJECTED',
            resource: 'endpoint', resourceId: node.endpointId,
            meta: { rustdeskId: dto.rustdeskId, reason: dto.agentSecret ? 'secret_mismatch' : 'secret_missing' },
          });
          throw new UnauthorizedException('This device is not recognised');
        }
        authenticated = true;
      }
      // A node with no stored secret is NOT bound here. It used to bind the
      // first secret offered, which made the secret worth nothing for exactly
      // the nodes that lacked one: whoever knew the RustDesk ID and heartbeated
      // first became the device — receiving rotations and setting the password
      // the console hands technicians. Binding happens only on a claim, which
      // redeems an operator-issued token. Until its installer is re-run with
      // one, such a node gets liveness and nothing else.
    }

    // Always accept the password sent by the endpoint. The prior first-write-
    // only guard caused a real usability bug: re-running the installer on a
    // machine that had already heartbeated set a NEW password on RustDesk
    // (via `rustdesk.exe --password`) but left the OLD password in the DB,
    // so the /connect flow shipped the wrong password to the client and
    // the "one click" required a manual password type. The security
    // tradeoff (an attacker who has already stolen an endpoint's RustDesk
    // ID could rotate the credential the endpoint sees) is acceptable:
    // they'd still need to also compromise the endpoint to use it, and
    // every change is audited.
    // Only from the device itself: an unauthenticated caller that could set
    // this would decide which password the console hands to technicians.
    const encryptedPassword = dto.password && authenticated ? this.encryptPassword(dto.password) : undefined;

    if (!node) {
      // Auto-create an unassigned endpoint + node in the pending pool.
      // Requires the device secret: without it this is an unauthenticated row
      // factory, and every installer this server hands out sends one.
      if (!dto.agentSecret) {
        throw new UnauthorizedException('This device is not recognised');
      }
      const endpoint = await this.prisma.endpoint.create({
        data: {
          tenantId: null,
          name: dto.hostname ?? dto.rustdeskId,
          hostname: dto.hostname ?? null,
          platform: dto.platform ?? null,
          osVersion: dto.osVersion ?? null,
          agentVersion: dto.agentVersion ?? null,
          ipAddress: dto.ipAddress ?? null,
          lastSeenAt: new Date(),
          isOnline: true,
          status: 'PENDING_ENROLLMENT',
        },
      });
      await this.prisma.rustdeskNode.create({
        data: {
          tenantId: null,
          endpointId: endpoint.id,
          rustdeskId: dto.rustdeskId,
          hostname: dto.hostname ?? null,
          platform: dto.platform ?? null,
          lastSeenAt: new Date(),
          agentSecretHash: this.hashSecret(dto.agentSecret),
          agentSecretSetAt: new Date(),
          ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
        },
      });
      return {
        found: false,
        authenticated: true,
        rustdeskRegistered: await this.peerRegisteredWithHbbs(dto.rustdeskId),
      };
    }

    // Liveness is recorded for anyone who knows the ID — it is only a
    // timestamp, and refusing it would take a fleet enrolled before device
    // secrets existed offline. Everything descriptive needs the secret.
    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: {
        lastSeenAt: new Date(),
        // The bound secret matched again, so any candidate recorded while it
        // did not is moot — and must not stay acceptable.
        ...(authenticated && node.candidateSecretHash && {
          candidateSecretHash: null, candidateSecretSeenAt: null, candidateSecretFirstAt: null,
          candidateSecretIp: null, candidateSecretConflict: false,
        }),
        ...(authenticated && dto.hostname !== undefined && { hostname: dto.hostname }),
        ...(authenticated && dto.platform !== undefined && { platform: dto.platform }),
        ...(authenticated && dto.rustdeskVersion !== undefined && { version: dto.rustdeskVersion }),
        ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
        // A staged update clears once the endpoint reports the target version.
        // Comparing reported-vs-target rather than assuming success means a
        // failed or partial install simply retries on the next heartbeat.
        ...(authenticated &&
        node.updateRequestedAt &&
        node.updateTargetVersion &&
        dto.rustdeskVersion === node.updateTargetVersion
          ? { updateRequestedAt: null, updateTargetVersion: null }
          : {}),
        // A reinstall clears once the endpoint reports an agent matching this
        // server AND the request has been handed out at least once. Without
        // the dispatch half, a repair reinstall of an already-current agent
        // would be cancelled by the very heartbeat that collected it, and the
        // installer would never run.
        ...(authenticated &&
        node.reinstallRequestedAt &&
        node.reinstallDispatchedAt &&
        dto.agentVersion === this.platformVersion()
          ? { reinstallRequestedAt: null, reinstallRequestedBy: null, reinstallDispatchedAt: null }
          : {}),
      },
    });

    const updateData: Record<string, unknown> = {
      lastSeenAt: new Date(),
      isOnline: true,
      ...(authenticated && dto.hostname !== undefined && { hostname: dto.hostname }),
      ...(authenticated && dto.platform !== undefined && { platform: dto.platform }),
      ...(authenticated && dto.osVersion !== undefined && { osVersion: dto.osVersion }),
      // Accepted by the DTO since v0.8.x and dropped on the floor ever since:
      // there was no column, so the device page's "Agent" row showed a dash on
      // every machine ever enrolled. It is the fastest way to see that a
      // machine's agent is too old to collect an inventory.
      ...(authenticated && dto.agentVersion !== undefined && { agentVersion: dto.agentVersion }),
      // The address decides where the machine appears on the dashboard map and
      // what the audit trail records, so it is the device's to report or nobody's.
      ...(authenticated && dto.ipAddress !== undefined && { ipAddress: dto.ipAddress }),
    };

    await this.prisma.endpoint.update({
      where: { id: node.endpointId },
      data: updateData,
    });

    // If a credential rotation is pending for this node, include the new
    // plaintext in the response. The endpoint applies it via
    // rustdesk.exe --password and POSTs to /enrollment/confirm-rotation.
    let rotate: { password: string; sha256: string } | null = null;
    const refreshed = authenticated
      ? await this.prisma.rustdeskNode.findUnique({
          where: { id: node.id }, select: { pendingPassword: true },
        })
      : null;
    if (refreshed?.pendingPassword) {
      try {
        const plain = this.decryptPassword(refreshed.pendingPassword);
        const sha = createHash('sha256').update(plain).digest('hex');
        rotate = { password: plain, sha256: sha };
      } catch { /* ignore */ }
    }

    // Tell the endpoint to upgrade its RustDesk client when one is staged and
    // it is not already on the target. The endpoint re-runs the installer,
    // which is idempotent and pins whatever version this server serves.
    const updateRustdesk =
      authenticated &&
      node.updateRequestedAt &&
      node.updateTargetVersion &&
      dto.rustdeskVersion !== node.updateTargetVersion
        ? { targetVersion: node.updateTargetVersion }
        : null;

    // An operator-requested agent reinstall. Same mechanism as the RustDesk
    // upgrade — re-run the installer, which is idempotent and keeps the
    // machine's existing configuration, password and enrolment — but reachable
    // regardless of which RustDesk version the endpoint is on.
    let reinstallAgent: { targetVersion: string } | null = null;
    if (authenticated && node.reinstallRequestedAt) {
      reinstallAgent = { targetVersion: this.platformVersion() };
      // Recorded before the response goes out, so a request is only ever
      // considered satisfiable after the endpoint has genuinely been told.
      if (!node.reinstallDispatchedAt) {
        await this.prisma.rustdeskNode.update({
          where: { id: node.id },
          data: { reinstallDispatchedAt: new Date() },
        }).catch(() => { /* best-effort: never cost the endpoint its heartbeat */ });
      }
    }

    // Live session state, and whatever collection work is queued for this
    // machine. Both are gated on `authenticated` for the same reason the
    // descriptive fields above are: an anonymous caller that could write these
    // would decide what the console says is running on a customer's computer,
    // and an anonymous caller that could collect a command would decide what
    // that computer goes and reads.
    let commands: { id: string; type: string; params: unknown }[] = [];
    if (authenticated) {
      // Inventory writes are best-effort: a malformed report, or a database
      // hiccup writing one, must not cost the endpoint its liveness ping. That
      // is what marks it offline on the dashboard.
      try {
        await this.inventory.recordLiveState(node.endpointId, {
          loggedOnUser: dto.loggedOnUser,
          uptimeSeconds: dto.uptimeSeconds,
          lastBootAt: dto.lastBootAt,
          cpuLoadPercent: dto.cpuLoadPercent,
          memoryTotalMb: dto.memoryTotalMb,
          memoryFreeMb: dto.memoryFreeMb,
          systemDiskTotalMb: dto.systemDiskTotalMb,
          systemDiskFreeMb: dto.systemDiskFreeMb,
        });
        commands = await this.inventory.collectForHeartbeat(node.endpointId);
      } catch (e) {
        this.logger.warn(`Inventory step failed for endpoint ${node.endpointId}: ${String(e)}`);
      }
    }

    // An unauthenticated caller gets the liveness ack and nothing that would
    // tell it which record a RustDesk ID belongs to.
    if (!authenticated) {
      return { found: true, authenticated: false, rotate: null, updateRustdesk: null, reinstallAgent: null, commands: [] };
    }

    return {
      found: true,
      endpointId: node.endpointId,
      // False for a machine enrolled before device secrets existed. Its
      // installer needs re-running before the server will take anything it
      // says, or hand it a rotation.
      authenticated,
      rotate,
      updateRustdesk,
      reinstallAgent,
      commands,
      rustdeskRegistered: await this.peerRegisteredWithHbbs(dto.rustdeskId),
    };
  }

  /**
   * An endpoint reporting the result of a command it was handed.
   *
   * Public by nature — a machine speaks here, not a person — so the device
   * secret is not optional the way it is on the heartbeat. A heartbeat without
   * one still has a job (recording liveness for a fleet enrolled before
   * secrets existed); a command result without one has none, and accepting it
   * would let anyone who knows a RustDesk ID write a customer's event log
   * contents into the console.
   */
  async commandResult(dto: {
    rustdeskId: string; agentSecret: string; commandId: string; ok: boolean;
    error?: string; inventory?: unknown; updates?: unknown; events?: unknown;
  }) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId: dto.rustdeskId },
      select: { id: true, tenantId: true, endpointId: true, agentSecretHash: true },
    });
    if (!node?.agentSecretHash || !this.secretMatches(node.agentSecretHash, dto.agentSecret)) {
      await this.audit.log({
        tenantId: node?.tenantId ?? undefined,
        action: 'ENDPOINT_HEARTBEAT_REJECTED',
        resource: 'endpoint', resourceId: node?.endpointId,
        meta: { rustdeskId: dto.rustdeskId, reason: 'command_result_unauthenticated' },
      });
      throw new UnauthorizedException('This device is not recognised');
    }

    return this.inventory.completeCommand(node.endpointId, dto.commandId, {
      ok: dto.ok,
      error: dto.error,
      inventory: dto.inventory,
      updates: dto.updates,
      events: dto.events,
    });
  }

  /**
   * Does this heartbeat come from the machine it claims to be?
   *
   * `/enrollment/heartbeat` is necessarily unauthenticated — it is called by a
   * machine, not a person — and it used to take the RustDesk ID as proof of
   * identity. That number is printed in the RustDesk window and handed to
   * every technician who connects, so anyone who had seen one could collect
   * that machine's pending password rotation in plaintext, overwrite the
   * password the console hands out, and rewrite its hostname and address.
   *
   * The agent now sends a per-device secret. A node with a stored hash requires
   * a match; a node without one is bound only by a claim (an operator-issued
   * token), so re-running its installer is how such a machine authenticates.
   * A caller that offers nothing is not the device as far as this server is
   * concerned, and gets a liveness ping and nothing else.
   */
  /**
   * This server's version, as the agent should report after a reinstall.
   *
   * Read from disk per call rather than cached: an in-app update rewrites
   * version.json, and a stale cache here would keep handing out a reinstall
   * request that can never be satisfied because the target it compares
   * against no longer matches what a fresh installer bakes in.
   */
  private platformVersion(): string {
    try {
      const file = process.env.VERSION_FILE
        ?? path.join(process.env.PROJECT_ROOT ?? process.cwd(), 'version.json');
      const v = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
      return v.version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Remember the secret a rejected heartbeat offered, so an operator can
   * accept it (EndpointsService.acceptDeviceSecret). Nothing here trusts it.
   *
   * The legitimate case is one machine offering one new secret every three
   * minutes. Anyone else who knows the RustDesk ID can offer a secret too, but
   * not without the real machine continuing to offer its own — so a different
   * secret arriving while the current candidate is still live marks the
   * candidate as conflicted, and a conflicted candidate cannot be accepted
   * until one secret has held alone for CANDIDATE_SETTLE_MS.
   */
  private async recordCandidateSecret(
    nodeId: string,
    node: { candidateSecretHash: string | null; candidateSecretSeenAt: Date | null;
      candidateSecretFirstAt: Date | null; candidateSecretConflict: boolean },
    offered: string,
    remoteIp?: string,
  ) {
    const now = new Date();
    const hash = this.hashSecret(offered);
    const same = !!node.candidateSecretHash && this.secretMatches(node.candidateSecretHash, offered);
    const live = !!node.candidateSecretSeenAt &&
      now.getTime() - node.candidateSecretSeenAt.getTime() < CANDIDATE_LIVE_MS;
    const data = same
      ? {
          candidateSecretSeenAt: now,
          candidateSecretIp: remoteIp ?? null,
          // A conflict clears once the same secret has been the only one
          // offered for long enough.
          ...(node.candidateSecretConflict && node.candidateSecretFirstAt &&
            now.getTime() - node.candidateSecretFirstAt.getTime() >= CANDIDATE_SETTLE_MS
            ? { candidateSecretConflict: false } : {}),
        }
      : {
          candidateSecretHash: hash,
          candidateSecretSeenAt: now,
          candidateSecretFirstAt: now,
          candidateSecretIp: remoteIp ?? null,
          candidateSecretConflict: !!node.candidateSecretHash && live,
        };
    await this.prisma.rustdeskNode.update({ where: { id: nodeId }, data })
      .catch(() => { /* best-effort: the rejection itself is what matters */ });
  }

  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  private secretMatches(stored: string, offered: string): boolean {
    const a = Buffer.from(stored, 'utf8');
    const b = Buffer.from(this.hashSecret(offered), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private decryptPassword(data: string): string {
    const [ivHex, tagHex, encHex] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', this.encKey, iv);
    decipher.setAuthTag(tag);
    return decipher.update(enc).toString('utf8') + decipher.final('utf8');
  }

  // Confirm a pending rotation. Called by the endpoint after it applied
  // the new password. rustdeskId + digest are the only inputs; the server
  // computes the expected digest from its own pending ciphertext.
  async confirmRotation(rustdeskId: string, passwordSha256: string, agentSecret?: string) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId },
      select: { id: true, tenantId: true, endpointId: true, pendingPassword: true, agentSecretHash: true },
    });
    if (!node?.pendingPassword) return { confirmed: false, reason: 'no_pending' };
    // A rotation is only ever handed to an authenticated device, so only an
    // authenticated device can confirm one.
    if (!node.agentSecretHash || !agentSecret || !this.secretMatches(node.agentSecretHash, agentSecret)) {
      throw new UnauthorizedException('This device is not recognised');
    }
    let plain: string;
    try { plain = this.decryptPassword(node.pendingPassword); }
    catch { return { confirmed: false, reason: 'decrypt_failed' }; }
    const expected = createHash('sha256').update(plain).digest('hex');
    if (expected !== passwordSha256) return { confirmed: false, reason: 'digest_mismatch' };

    await this.prisma.rustdeskNode.update({
      where: { id: node.id },
      data: {
        permanentPassword: node.pendingPassword,
        pendingPassword: null,
        pendingPasswordAt: null,
      },
    });
    await this.audit.log({
      tenantId: node.tenantId ?? undefined,
      action: 'ENDPOINT_CREDENTIAL_ROTATED',
      resource: 'endpoint', resourceId: node.endpointId,
    });
    return { confirmed: true };
  }


  /**
   * Ask hbbs whether a peer has ever completed registration.
   *
   * This is the difference between "RustDesk is installed and configured" and
   * "RustDesk can actually be connected to". An endpoint can hold a perfect
   * config on disk, heartbeat us over 443 every 3 minutes, and still never
   * reach 21116 — which is indistinguishable from offline in the UI and lets
   * the installer report success for a machine nobody can connect to.
   *
   * hbbs (OSS) exposes no API, so its SQLite peer table is the only source of
   * truth. We shell out to the sqlite3 CLI rather than take a dependency:
   * node:sqlite does not exist on the Node 20 this service runs under, and
   * better-sqlite3 would mean a compiled native module for one read-only
   * query. The id is validated as digits before it reaches the SQL text.
   *
   * Returns null — never throws, never false — when the question cannot be
   * answered (hbbs on another host, file unreadable, sqlite3 absent, WAL
   * unreadable). Callers MUST treat null as "unknown", not as a failure:
   * refusing an install because we could not read a file would be worse than
   * the bug this exists to catch.
   */
  async peerRegisteredWithHbbs(rustdeskId: string): Promise<boolean | null> {
    if (!/^[0-9]{6,15}$/.test(rustdeskId)) return null;
    const dbPath =
      this.config.get<string>('RUSTDESK_DB_PATH') ??
      '/var/lib/rustdesk-server/db_v2.sqlite3';
    try {
      const { stdout } = await execFileAsync(
        'sqlite3',
        [`file:${dbPath}?mode=ro`, `SELECT 1 FROM peer WHERE id='${rustdeskId}' LIMIT 1;`],
        { timeout: 3000 },
      );
      return stdout.trim() === '1';
    } catch {
      return null;
    }
  }

  /**
   * Liveness from two sources: the agent heartbeat (lastSeenAt) and hbbs.
   * A machine RustDesk can reach is online even when its agent is silent —
   * calling it offline sent operators to the machine for nothing. hbbs being
   * unreachable degrades to heartbeat-only, exactly the old behaviour.
   * lastSeenAt stays the agent's own check-in, so a dead agent is still
   * visible on the device page.
   */
  async markStaleEndpointsOffline(thresholdMinutes = 10) {
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);
    const nodes = await this.prisma.rustdeskNode.findMany({
      select: { rustdeskId: true, endpointId: true },
    });
    const online = await queryHbbsOnline(nodes.map((n) => n.rustdeskId), {
      host: this.config.get<string>('HBBS_PRESENCE_HOST') || undefined,
      port: Number(this.config.get<string>('HBBS_PRESENCE_PORT')) || undefined,
    });
    const reachable = online
      ? nodes.filter((n) => online.has(n.rustdeskId)).map((n) => n.endpointId)
      : [];
    if (reachable.length > 0) {
      await this.prisma.endpoint.updateMany({
        where: { id: { in: reachable }, isOnline: false },
        data: { isOnline: true },
      });
    }
    const result = await this.prisma.endpoint.updateMany({
      where: {
        isOnline: true,
        id: { notIn: reachable },
        // Unknown hbbs state must not take machines offline that only hbbs
        // was keeping online: wait for the heartbeat window like before.
        lastSeenAt: { lt: cutoff },
      },
      data: { isOnline: false },
    });
    if (result.count > 0) {
      this.logger.log(`Marked ${result.count} stale endpoint(s) offline`);
    }
  }

  async revokeClaimToken(actor: ActorContext, tokenId: string) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_REMOVE);
    const scope = this.acl.resolveScope(actor);

    const record = await this.prisma.deviceClaimToken.findFirst({
      where: { id: tokenId, ...(scope ? { customerId: scope } : {}) },
    });
    if (!record) throw new NotFoundException('Token not found');

    if (record.claimedAt) {
      throw new BadRequestException('Cannot revoke an already-claimed token');
    }

    await this.prisma.deviceClaimToken.delete({ where: { id: tokenId } });
    await this.audit.log({
      tenantId: record.tenantId, customerId: record.customerId ?? undefined,
      actorId: actor.userId, actorIp: actor.ip,
      action: 'ENDPOINT_UNASSIGNED', resource: 'device_claim_token', resourceId: tokenId,
      meta: { revoked: true },
    });
    return { revoked: true };
  }
}
