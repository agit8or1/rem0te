import { ActionsService } from '../actions/actions.service';
import { HEARTBEAT_STALE_MS } from '../common/connectivity';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { AgentMigrationService } from '../update-trust/agent-migration.service';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
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
import { SessionEventsService } from '../sessions/session-events.service';
import { UpdateRolloutService } from '../admin/update-rollout.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { DiagnosticsCatalogService } from '../diagnostics-catalog/diagnostics-catalog.service';
import { ContainmentService } from '../containment/containment.service';
import { ClientUpdatesService } from '../client-updates/client-updates.service';
import { EndpointInventoryService } from '../endpoint-inventory/endpoint-inventory.service';
import { CANDIDATE_LIVE_MS, CANDIDATE_SETTLE_MS } from './device-secret';
import { deviceText, withDeviceText } from './device-text';
import { queryHbbsOnline } from './hbbs-presence';
import { HbbsPeerSnapshot, PEER_SNAPSHOT_SQL, parsePeerIds } from './hbbs-peer-snapshot';
import { compareVersions } from '../common/agent-contract';
import { assertFresh } from '../security-controls/review';
import { MetricsService } from '../metrics/metrics.service';
import { ChatService } from '../chat/chat.service';

const execFileAsync = promisify(execFile);

/**
 * How a token mint proved more than a session (0.33): a fresh step-up for a
 * person, or the API key itself. Every caller of createClaimToken has to say
 * which, so a new route cannot mint on a bare session by forgetting.
 */
export type TokenMintAuth =
  | { via: 'session'; freshMethod: string | null }
  | { via: 'api-key'; apiKeyId: string | undefined };

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
    private readonly sessionEvents: SessionEventsService,
    private readonly rollouts: UpdateRolloutService,
    private readonly updateTrust: UpdateTrustService,
    private readonly actions: ActionsService,
    private readonly containment: ContainmentService,
    private readonly monitoring: MonitoringService,
    private readonly diagnostics: DiagnosticsCatalogService,
    private readonly clientUpdates: ClientUpdatesService,
    private readonly metrics: MetricsService,
    private readonly agentMigration: AgentMigrationService,
    private readonly chat: ChatService,
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
   *
   * Minting needs proof beyond the session (0.33). An enrolment token puts a
   * machine of the holder's choosing into a business, where it is handed that
   * business's monitoring, update policies and relay configuration — so a
   * stolen or unattended session must not be enough. A signed-in person needs
   * a fresh re-authentication (step-up, ten minutes, this sign-in only),
   * whatever their role and whatever step-up actions are configured. An API
   * key cannot step up; it keeps the ability because the key is itself the
   * second proof — a separate secret, bound to one business, carrying the
   * explicit `enrollment:write` scope, and creating any key needs the same
   * fresh re-authentication (ApiKeysService.create). The check runs after
   * every scope and input check, so someone with no business here is refused
   * outright rather than asked to re-authenticate first.
   */
  async createClaimToken(actor: ActorContext, dto: CreateClaimTokenDto & { businessId?: string }, auth: TokenMintAuth) {
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
      // The business's own group, or a pre-0.33 one with no business in the
      // same tenant (0.33: a group holds only its own business's computers).
      const group = await this.prisma.endpointGroup.findFirst({
        where: { id: dto.endpointGroupId, OR: [{ customerId: businessId }, { customerId: null, tenantId: business.tenantId }] },
        select: { id: true, kind: true },
      });
      if (!group) throw new BadRequestException('Unknown computer group');
      // 0.34: a claim adds a membership row, which a rule group never has.
      if (group.kind === 'RULE') throw new BadRequestException({ code: 'RULE_GROUP', message: 'That is a rule group: a new computer is in it when it matches the rule. Pick a static group, or none.' });
    }

    // The site, like the business, is fixed now. It must be an active site of
    // THIS business: a site id from another business is refused with the same
    // message as one that does not exist, so it cannot be used to probe.
    let site: { id: string; name: string } | null = null;
    if (dto.siteId) {
      site = await this.prisma.site.findFirst({
        where: { id: dto.siteId, customerId: businessId, isActive: true },
        select: { id: true, name: true },
      });
      if (!site) throw new BadRequestException('Unknown site for this business');
    }

    if (auth.via === 'session') {
      assertFresh(auth.freshMethod, {
        action: 'enrollment.create',
        message: 'Confirm it is you to make an install link: an enrolment token adds a computer to this business.',
      });
    } else if (!auth.apiKeyId) {
      throw new ForbiddenException('Only an API key with the enrollment:write scope can mint a token without a fresh sign-in');
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
        siteName: site?.name ?? dto.siteName ?? null,
        siteId: site?.id ?? null,
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
        ...(site ? { siteId: site.id } : {}),
        accessMode: dto.accessMode ?? 'ASSIGNED_USERS',
        assignedUserIds,
        // What proved this was not just a session (0.33).
        ...(auth.via === 'session' ? { mintedVia: 'session', stepUpMethod: auth.freshMethod } : { mintedVia: 'api-key', apiKeyId: auth.apiKeyId }),
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

  /**
   * Has the device this token was made for appeared yet, and how is it? (Add
   * device, step 4 and 5.)
   *
   * The token is looked up inside the caller's business, exactly as the token
   * list is; a token of another business is a 404, never a 403. The device is
   * then read through `endpointVisibilityWhere`, AND-ed with its id: a person
   * who may mint tokens is not thereby entitled to see every computer one
   * enrols (a Business User minting an ASSIGNED_USERS token for somebody
   * else), so such a device is reported as enrolled but not shown.
   *
   * Nothing secret leaves here: no token, no token hash, no device secret —
   * only whether a secret is bound, and when.
   */
  async claimTokenStatus(actor: ActorContext, tokenId: string) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const scope = this.acl.resolveScope(actor);
    const record = await this.prisma.deviceClaimToken.findFirst({
      where: { id: tokenId, ...(scope ? { customerId: scope } : {}) },
      select: {
        id: true, customerId: true, customerName: true, siteId: true, siteName: true, endpointId: true,
        accessMode: true, description: true, createdAt: true, expiresAt: true, claimedAt: true,
      },
    });
    if (!record) throw new NotFoundException('Token not found');

    const now = new Date();
    let state: 'waiting' | 'expired' | 'claiming' | 'enrolled';
    if (!record.claimedAt) state = record.expiresAt < now ? 'expired' : 'waiting';
    // Consumed, but the claim has not yet recorded what it enrolled (a fresh
    // token's endpointId is written last). Either it finishes in a moment or
    // it fails and hands the token back.
    else state = record.endpointId ? 'enrolled' : 'claiming';

    let device: Record<string, unknown> | null = null;
    let deviceVisible = false;
    if (state === 'enrolled' && record.endpointId) {
      const ep = await this.prisma.endpoint.findFirst({
        where: { AND: [this.acl.endpointVisibilityWhere(actor, record.customerId), { id: record.endpointId }] },
        select: {
          id: true, name: true, hostname: true, platform: true, osVersion: true, status: true,
          isOnline: true, lastSeenAt: true, createdAt: true, agentVersion: true, updateChannel: true,
          customerId: true, customer: { select: { id: true, name: true } },
          site: { select: { id: true, name: true } },
          rustdeskNode: { select: { agentSecretHash: true, agentSecretSetAt: true, lastSeenAt: true } },
          inventory: { select: { collectedAt: true, liveSampledAt: true, osCaption: true, updatesCheckedAt: true } },
        },
      });
      if (ep) {
        deviceVisible = true;
        const { rustdeskNode: node, inventory: inv, ...rest } = ep;
        device = {
          ...rest,
          // Same three-way classification as the device list.
          agentType: ep.updateChannel === 'signed' ? 'signed' : ep.agentVersion ? 'standard' : 'none',
          agentBound: !!node?.agentSecretHash,
          agentBoundAt: node?.agentSecretSetAt ?? null,
          inventoryCollectedAt: inv?.collectedAt ?? null,
          liveSampledAt: inv?.liveSampledAt ?? null,
          updatesCheckedAt: inv?.updatesCheckedAt ?? null,
          osCaption: inv?.osCaption ?? null,
        };
      }
    }

    return {
      token: {
        id: record.id, businessId: record.customerId, businessName: record.customerName,
        siteId: record.siteId, siteName: record.siteName, accessMode: record.accessMode,
        description: record.description, createdAt: record.createdAt, expiresAt: record.expiresAt,
        claimedAt: record.claimedAt,
      },
      state,
      deviceVisible,
      device,
    };
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
      return await this.claimWithConsumedToken(withDeviceText(dto), record, claimedByIp);
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
    let adoptedEndpointId: string | null = null;

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
        // Adopt the unassigned node/endpoint into the token's business. It
        // takes the same path as a re-enrolment below, so the token's
        // business, group, access mode, assigned users, password and hostname
        // all apply — returning early here used to leave the adopted computer
        // with only a tenant, outside the business the token was minted for.
        adoptedEndpointId = existingNode.endpointId;
      } else {
        // Token has endpointId — delete the unassigned duplicate and proceed with normal token flow
        await this.prisma.rustdeskNode.delete({ where: { id: existingNode.id } });
        await this.prisma.endpoint.delete({ where: { id: existingNode.endpointId } });
      }
    }

    // The token's site, re-checked now: it was validated at mint time, but a
    // site can be deactivated in the 24 hours a token lives. A site that no
    // longer qualifies is dropped rather than failing the install — the device
    // still lands in the right business, just without a site.
    const siteId = record.siteId && record.customerId
      ? (await this.prisma.site.findFirst({
          where: { id: record.siteId, customerId: record.customerId, isActive: true },
          select: { id: true },
        }))?.id ?? null
      : null;
    // The token's device group, the same way (0.33): it must still exist and
    // still be this business's (or a pre-0.33 group of the tenant). A group
    // deleted since the token was made is dropped, not an install failure.
    // Since 0.34 it is a membership the claim ADDS: a re-enrolled computer
    // keeps its other groups in the same business.
    const groupId = record.endpointGroupId
      ? (await this.prisma.endpointGroup.findFirst({
          // kind STATIC: a token can never name a rule group (refused when it
          // was made, and a group's kind never changes), but the claim must
          // not depend on that — the 0053 trigger would fail the install.
          where: { id: record.endpointGroupId, kind: 'STATIC', OR: [{ customerId: record.customerId ?? '__none__' }, { customerId: null, tenantId: record.tenantId }] },
          select: { id: true },
        }))?.id ?? null
      : null;

    const boundEndpointId = record.endpointId ?? adoptedEndpointId;
    let endpoint = boundEndpointId
      ? await this.prisma.endpoint.findUnique({ where: { id: boundEndpointId } })
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
          tenantId: record.tenantId,
          // A pooled computer was named by its own heartbeat; name it as a fresh enrolment would.
          ...(adoptedEndpointId && dto.hostname ? { name: dto.hostname } : {}),
          ...(record.customerId ? { customerId: record.customerId } : {}),
          ...(siteId ? { siteId } : {}),
          // A computer that changes business leaves its old business's
          // groups: the endpoint_leaves_foreign_groups trigger (0049) does
          // that in this statement; the token's group is added below.
          accessMode: record.accessMode,
        },
      });
      // After the update, so the trigger has already cleared any group of a
      // business the computer just left; the insert trigger refuses a group
      // of any other business.
      if (groupId) {
        await this.prisma.endpointGroupMember.createMany({ data: [{ endpointGroupId: groupId, endpointId: endpoint.id }], skipDuplicates: true });
      }
    } else {
      // Create new endpoint from token+claim context. customerId and the
      // group come from the token so the endpoint cannot enroll itself into
      // a different business.
      endpoint = await this.prisma.endpoint.create({
        data: {
          tenantId: record.tenantId,
          customerId: record.customerId ?? null,
          siteId,
          ...(groupId ? { groupMemberships: { create: { endpointGroupId: groupId } } } : {}),
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
        tenantId: record.tenantId,
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
        ...(siteId ? { siteId } : {}),
        ...(groupId ? { groupId } : {}),
        ...(adoptedEndpointId ? { adoptedFromPool: true } : {}),
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
    rustdeskSessions?: number; updateNonce?: string;
    updateChannel?: 'signed' | 'legacy'; trustRootVersion?: number; targetsVersion?: number;
    agentActions?: string[]; agentSha256?: string; actionResults?: unknown[];
    patchPosture?: Record<string, unknown>; agentChat?: number;
    agentUpdateCheckedAt?: string; agentUpdateResult?: string;
  }, remoteIp?: string) {
    // Names and versions as text, never control codes (0.32) — see device-text.ts.
    dto = withDeviceText(dto);
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId: dto.rustdeskId },
    });

    // Identity check before anything is read or written. See secretMatches().
    let authenticated = false;
    if (node) {
      if (node.agentSecretHash) {
        if (!dto.agentSecret || !this.secretMatches(node.agentSecretHash, dto.agentSecret)) {
          if (dto.agentSecret) await this.recordCandidateSecret(node.id, node, dto.agentSecret, remoteIp, dto.password);
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
          candidateSecretIp: null, candidateSecretConflict: false, candidatePassword: null,
        }),
        ...(authenticated && dto.hostname !== undefined && { hostname: dto.hostname }),
        ...(authenticated && dto.platform !== undefined && { platform: dto.platform }),
        ...(authenticated && dto.rustdeskVersion !== undefined && { version: dto.rustdeskVersion }),
        ...(authenticated && dto.rustdeskSessions !== undefined && {
          rdSessionsActive: dto.rustdeskSessions, rdSessionsObservedAt: new Date(),
        }),
        ...(encryptedPassword ? { permanentPassword: encryptedPassword } : {}),
        // A staged update clears once the endpoint reports the target version
        // or newer. Comparing reported-vs-target rather than assuming success
        // means a failed or partial install simply retries on the next
        // heartbeat. "Or newer" matters: the installer installs the latest
        // release, not the staged one, so an update staged for 1.5.0 that
        // installed 1.5.1 never matched exactly and re-ran the installer on
        // every heartbeat.
        ...(authenticated &&
        node.updateRequestedAt &&
        node.updateTargetVersion &&
        dto.rustdeskVersion &&
        compareVersions(dto.rustdeskVersion, node.updateTargetVersion) >= 0
          ? { updateRequestedAt: null, updateTargetVersion: null, updateRequestSource: null, updateRequestedById: null, updateHoldReason: null, updateHoldAt: null, updatePolicyId: null }
          : {}),
        // A reinstall clears once the endpoint reports an agent matching this
        // server AND the request has been handed out at least once. Without
        // the dispatch half, a repair reinstall of an already-current agent
        // would be cancelled by the very heartbeat that collected it, and the
        // installer would never run.
        ...(authenticated &&
        node.reinstallRequestedAt &&
        node.reinstallDispatchedAt &&
        (dto.agentVersion === this.platformVersion() || signedCheckedSince(dto, node.reinstallDispatchedAt))
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
      // Update channel (0.24). Self-reported, and only ever used to decide what
      // the portal withholds from a legacy agent — claiming "signed" gets an
      // agent less from the portal, never more.
      ...(authenticated && {
        updateChannel: dto.updateChannel === 'signed' ? 'signed' : 'legacy',
        trustRootVersion: dto.updateChannel === 'signed' ? dto.trustRootVersion ?? null : null,
        targetsVersion: dto.updateChannel === 'signed' ? dto.targetsVersion ?? null : null,
        trustReportedAt: new Date(),
        // Approved actions (0.26): only a signed agent can execute a plan, so
        // a legacy agent's claim is discarded rather than stored.
        agentActions: dto.updateChannel === 'signed' ? dto.agentActions ?? [] : [],
        agentSha256: dto.updateChannel === 'signed' ? dto.agentSha256 ?? null : null,
        // Chat (0.34): only the signed agent has a chat host.
        chatProtocol: dto.updateChannel === 'signed' ? dto.agentChat ?? null : null,
      }),
      // Agent upgrade (0.34): the agent's own last update check, from
      // agent-status.json — the signed agent's, or a migrate run's on a
      // standard machine. Shown, never acted on; made inert like every other
      // device-reported string.
      ...(authenticated && plausibleCheck(dto.agentUpdateCheckedAt) && {
        agentUpdateCheckedAt: new Date(dto.agentUpdateCheckedAt as string),
        agentUpdateResult: deviceText(dto.agentUpdateResult, 200) ?? null,
      }),
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
    // v0.28: an "updates" pause (global, or this business) withholds both, and
    // is asked before anything records the request as delivered.
    const updatesHeld = authenticated
      ? !!(await this.containment.blocking('updates', (await this.prisma.endpoint.findUnique({ where: { id: node.endpointId }, select: { customerId: true } }))?.customerId ?? null))
      : false;
    let updateRustdesk: { targetVersion: string; nonce?: string } | null =
      authenticated && !updatesHeld &&
      node.updateRequestedAt &&
      node.updateTargetVersion &&
      !(dto.rustdeskVersion && compareVersions(dto.rustdeskVersion, node.updateTargetVersion) >= 0)
        ? { targetVersion: node.updateTargetVersion }
        : null;

    // v0.32: a request the business's update policy queued is handed out only
    // inside that policy's window — and, when the policy says so, not while a
    // session is open or someone is logged on. A request someone made by hand
    // (MANUAL, or anything staged before 0.32) still goes now. Fails closed:
    // if the policy cannot be read, the automatic request waits.
    if (updateRustdesk && node.updateRequestSource === 'POLICY') {
      const hold = await this.clientUpdates.holdForHeartbeat(
        { id: node.id, endpointId: node.endpointId, updateHoldReason: node.updateHoldReason },
        { rustdeskSessions: dto.rustdeskSessions, loggedOnUser: dto.loggedOnUser },
      ).catch((e) => { this.logger.warn(`Update policy check failed for ${node.endpointId}: ${String(e)}`); return 'error'; });
      if (hold) updateRustdesk = null;
    }

    // An operator-requested agent reinstall. Same mechanism as the RustDesk
    // upgrade — re-run the installer, which is idempotent and keeps the
    // machine's existing configuration, password and enrolment — but reachable
    // regardless of which RustDesk version the endpoint is on.
    let reinstallAgent: { targetVersion: string; nonce?: string } | null = null;
    if (authenticated && !updatesHeld && node.reinstallRequestedAt) {
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

    // A staged rollout owns this computer's updates while it has a job here:
    // exact version, batch, window, backoff and evidence all come from it,
    // and the legacy one-click staging above must not also fire.
    let rolloutManaged = false;
    if (authenticated) {
      try {
        const managed = await this.rollouts.onHeartbeat({
          endpointId: node.endpointId, rustdeskId: dto.rustdeskId, authenticated,
          rustdeskVersion: dto.rustdeskVersion, agentVersion: dto.agentVersion, updateNonce: dto.updateNonce,
          reportedPassword: !!dto.password, rdSessionsActive: dto.rustdeskSessions, contained: updatesHeld,
        });
        if (managed.managed) {
          rolloutManaged = true;
          updateRustdesk = managed.updateRustdesk ?? null;
          reinstallAgent = managed.reinstallAgent ?? null;
        }
      } catch (e) {
        this.logger.warn(`Rollout step failed for endpoint ${node.endpointId}: ${String(e)}`);
      }
    }

    // Containment of the legacy update path (0.24). A legacy agent acts on
    // either flag by piping the portal's windows.ps1 into a SYSTEM shell; in
    // signed_only it is handed nothing to run, or — when portal-mediated
    // migration is allowed — only the reinstall flag, which fetches the
    // migration script in place of an installer.
    if (authenticated) {
      const gate = await this.updateTrust.gateForHeartbeat(dto.updateChannel === 'signed' ? 'signed' : 'legacy');
      if (gate === 'withhold') {
        updateRustdesk = null;
        reinstallAgent = null;
      } else if (gate === 'migrate') {
        updateRustdesk = null;
        reinstallAgent = { targetVersion: this.platformVersion() };
      }
    }

    // Per-computer migration to the signed agent (0.34). Only this computer's
    // own open request is read; the nonce goes out with the reinstall flag,
    // and windows.ps1 serves the migration script for that nonce alone. The
    // request is held — not handed out — under an updates pause, in Signed
    // only without portal migration (the gate above said withhold), or while
    // a rollout owns this computer. A signed heartbeat completes it.
    if (authenticated) {
      try {
        const mig = await this.agentMigration.forHeartbeat({
          endpointId: node.endpointId, channel: dto.updateChannel === 'signed' ? 'signed' : 'legacy',
          updatesHeld, rolloutManaged,
          gate: dto.updateChannel === 'signed' ? 'pass' : await this.updateTrust.gateForHeartbeat('legacy'),
        });
        if (mig) {
          updateRustdesk = null;
          reinstallAgent = { targetVersion: this.platformVersion(), nonce: mig.nonce };
        }
      } catch (e) {
        this.logger.warn(`Agent migration step failed for endpoint ${node.endpointId}: ${String(e)}`);
      }
    }

    // v0.28: updates paused everywhere or for this business. Nothing is
    // started; a staged rollout simply does not advance on this computer.
    if (updatesHeld) {
      updateRustdesk = null;
      reinstallAgent = null;
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
        const live = await this.inventory.recordLiveState(node.endpointId, {
          loggedOnUser: dto.loggedOnUser,
          uptimeSeconds: dto.uptimeSeconds,
          lastBootAt: dto.lastBootAt,
          cpuLoadPercent: dto.cpuLoadPercent,
          memoryTotalMb: dto.memoryTotalMb,
          memoryFreeMb: dto.memoryFreeMb,
          systemDiskTotalMb: dto.systemDiskTotalMb,
          systemDiskFreeMb: dto.systemDiskFreeMb,
        });
        // Metric history (0.33): the same sanitised values, as one sample.
        // Inside the authenticated branch on purpose — a heartbeat without
        // the device secret writes no history (check-security-invariants §30).
        if (live) {
          await this.metrics.recordHeartbeat(node.endpointId, live)
            .catch((e) => this.logger.warn(`Metric sample failed for ${node.endpointId}: ${String(e)}`));
        }
        commands = await this.inventory.collectForHeartbeat(node.endpointId);
      } catch (e) {
        this.logger.warn(`Inventory step failed for endpoint ${node.endpointId}: ${String(e)}`);
      }
    }

    // Monitoring (0.29): the resource monitors read the sample just written,
    // and the agent is told which services and event queries to report on.
    // Best-effort for the same reason as inventory: never cost the liveness ping.
    let monitor: Awaited<ReturnType<MonitoringService['heartbeatConfig']>> = null;
    if (authenticated) {
      try {
        await this.monitoring.onLiveSample(node.endpointId);
        monitor = await this.monitoring.heartbeatConfig(node.endpointId);
      } catch (e) {
        this.logger.warn(`Monitoring step failed for endpoint ${node.endpointId}: ${String(e)}`);
      }
    }

    // Diagnostics catalog (0.31): runs staged for this machine, as catalog
    // keys only. Authenticated heartbeats only, and best-effort like the rest.
    let diagnostics: { id: string; key: string }[] = [];
    if (authenticated) {
      try {
        diagnostics = await this.diagnostics.forHeartbeat(node.endpointId);
      } catch (e) {
        this.logger.warn(`Diagnostics step failed for endpoint ${node.endpointId}: ${String(e)}`);
      }
    }

    // Session evidence from the remote side. Only an authenticated heartbeat,
    // and only for this machine's own sessions — see reconcileEndpointSignal.
    if (authenticated && dto.rustdeskSessions !== undefined) {
      await this.sessionEvents.reconcileEndpointSignal(node.endpointId, dto.rustdeskSessions, new Date())
        .catch((e) => this.logger.warn(`Session reconcile failed for ${node.endpointId}: ${String(e)}`));
    }

    // Approved actions (0.26): record what the agent reports about envelopes
    // it was handed, then hand it any that are due. Authenticated, signed
    // agents only — and the portal is only a courier here: the agent verifies
    // every envelope against the approval key from the signed update chain.
    let actions: { jobId: string; envelope: unknown }[] = [];
    let actionAcks: string[] = [];
    // Staged patching (0.27): take the signed agent's posture, and ask for a
    // new scan when the last one is stale or someone asked for one.
    let patchPostureAck: string | null = null;
    let patchScan = false;
    if (authenticated) {
      try {
        if (dto.actionResults?.length) actionAcks = await this.actions.recordResults(node.endpointId, dto.actionResults);
        if (dto.updateChannel === 'signed') actions = await this.actions.forHeartbeat(node.endpointId);
      } catch (e) {
        this.logger.warn(`Action step failed for endpoint ${node.endpointId}: ${String(e)}`);
      }
      if (dto.updateChannel === 'signed') {
        try {
          if (dto.patchPosture) patchPostureAck = await this.inventory.recordPatchPosture(node.endpointId, dto.patchPosture);
          patchScan = await this.inventory.patchScanDue(node.endpointId);
        } catch (e) {
          this.logger.warn(`Patch posture step failed for endpoint ${node.endpointId}: ${String(e)}`);
        }
      }
    }

    // Chat (0.34): whether a conversation is open, so the signed agent starts
    // its chat host. A flag only — no names, no text: the host fetches those
    // over /enrollment/chat/poll with the device secret. Asked only of an
    // authenticated signed agent that reports a chat protocol, so the rest of
    // the fleet's heartbeats cost no query.
    let chat: { open: boolean } | null = null;
    if (authenticated && dto.updateChannel === 'signed' && (dto.agentChat ?? 0) >= 1) {
      try {
        chat = await this.chat.forHeartbeat(node.endpointId);
      } catch (e) {
        this.logger.warn(`Chat step failed for endpoint ${node.endpointId}: ${String(e)}`);
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
      actions,
      actionAcks,
      patchPostureAck,
      patchScan,
      monitor,
      diagnostics,
      chat,
      rustdeskRegistered: await this.peerRegisteredWithHbbs(dto.rustdeskId),
    };
  }

  /**
   * The device secret check every device-side route makes (0.34: the chat
   * routes), in one place: the node for this RustDesk ID must hold a secret
   * and the one offered must match it. A failure is audited exactly as the
   * other device routes audit theirs, and is the same 401.
   */
  async authenticateDevice(rustdeskId: string, agentSecret: string | undefined, reason: string) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId },
      select: { id: true, tenantId: true, endpointId: true, agentSecretHash: true },
    });
    if (!node?.agentSecretHash || !agentSecret || !this.secretMatches(node.agentSecretHash, agentSecret)) {
      await this.audit.log({
        tenantId: node?.tenantId ?? undefined,
        action: 'ENDPOINT_HEARTBEAT_REJECTED',
        resource: 'endpoint', resourceId: node?.endpointId,
        meta: { rustdeskId, reason },
      });
      throw new UnauthorizedException('This device is not recognised');
    }
    // A node not (or no longer) attached to a computer has no chat to serve.
    if (!node.endpointId) throw new NotFoundException('This device is not attached to a computer');
    return { endpointId: node.endpointId, tenantId: node.tenantId };
  }

  /**
   * The agent's monitor report (0.29). Device secret required: a report is
   * evidence the console acts on, and without the secret anyone who knows a
   * RustDesk ID could raise — or clear — a customer's alerts.
   */
  async monitorReport(dto: { rustdeskId: string; agentSecret: string; services?: unknown[]; events?: unknown[] }) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId: dto.rustdeskId },
      select: { id: true, tenantId: true, endpointId: true, agentSecretHash: true },
    });
    if (!node?.agentSecretHash || !this.secretMatches(node.agentSecretHash, dto.agentSecret)) {
      await this.audit.log({
        tenantId: node?.tenantId ?? undefined,
        action: 'ENDPOINT_HEARTBEAT_REJECTED',
        resource: 'endpoint', resourceId: node?.endpointId,
        meta: { rustdeskId: dto.rustdeskId, reason: 'monitor_report_unauthenticated' },
      });
      throw new UnauthorizedException('This device is not recognised');
    }
    return this.monitoring.ingestReport(node.endpointId, { services: dto.services, events: dto.events });
  }

  /**
   * The agent reporting on a diagnostic run (0.31). Device secret required,
   * exactly as for command-result: a result is evidence the console shows,
   * and without the secret anyone who knows a RustDesk ID could write it.
   */
  async diagnosticResult(dto: { rustdeskId: string; agentSecret: string; runId: string; key: string; state: string; result?: unknown; error?: string }) {
    const node = await this.prisma.rustdeskNode.findUnique({
      where: { rustdeskId: dto.rustdeskId },
      select: { id: true, tenantId: true, endpointId: true, agentSecretHash: true },
    });
    if (!node?.agentSecretHash || !this.secretMatches(node.agentSecretHash, dto.agentSecret)) {
      await this.audit.log({
        tenantId: node?.tenantId ?? undefined,
        action: 'ENDPOINT_HEARTBEAT_REJECTED',
        resource: 'endpoint', resourceId: node?.endpointId,
        meta: { rustdeskId: dto.rustdeskId, reason: 'diagnostic_result_unauthenticated' },
      });
      throw new UnauthorizedException('This device is not recognised');
    }
    return this.diagnostics.report(node.endpointId, dto);
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
    offeredPassword?: string,
  ) {
    const now = new Date();
    // The password travels with the secret it came with. A later request with
    // the same secret but no password (the installer's registration check, a
    // heartbeat whose state file lost it) must not erase it; a different
    // secret starts over, so one machine's password can never be accepted
    // under another's secret.
    const pw = offeredPassword ? { candidatePassword: this.encryptPassword(offeredPassword) } : {};
    const hash = this.hashSecret(offered);
    const same = !!node.candidateSecretHash && this.secretMatches(node.candidateSecretHash, offered);
    const live = !!node.candidateSecretSeenAt &&
      now.getTime() - node.candidateSecretSeenAt.getTime() < CANDIDATE_LIVE_MS;
    const data = same
      ? {
          candidateSecretSeenAt: now,
          candidateSecretIp: remoteIp ?? null,
          ...pw,
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
          candidatePassword: null,
          ...pw,
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
   * query.
   *
   * Since 0.34 the read is shared: one sqlite3 reads every digits-only peer ID
   * at most once per HBBS_PEER_CACHE_SECONDS (default 10, clamped to 1–30) and
   * every heartbeat in that window answers from it — see hbbs-peer-snapshot.ts
   * for why that cannot make an unregistered ID look registered for longer
   * than the window. It was one process per heartbeat, which was most of the
   * API's CPU at 5,000 computers.
   *
   * Returns null — never throws, never false — when the question cannot be
   * answered (hbbs on another host, file unreadable, sqlite3 absent, WAL
   * unreadable). Callers MUST treat null as "unknown", not as a failure:
   * refusing an install because we could not read a file would be worse than
   * the bug this exists to catch. A failed read discards any earlier snapshot,
   * so it is null for everyone, never an older answer.
   */
  async peerRegisteredWithHbbs(rustdeskId: string): Promise<boolean | null> {
    return this.hbbsPeers.has(rustdeskId);
  }

  private _hbbsPeers: HbbsPeerSnapshot | null = null;
  private get hbbsPeers(): HbbsPeerSnapshot {
    if (!this._hbbsPeers) {
      const dbPath =
        this.config.get<string>('RUSTDESK_DB_PATH') ??
        '/var/lib/rustdesk-server/db_v2.sqlite3';
      const seconds = Number(this.config.get<string>('HBBS_PEER_CACHE_SECONDS'));
      this._hbbsPeers = new HbbsPeerSnapshot(
        async () => {
          const { stdout } = await execFileAsync(
            'sqlite3',
            [`file:${dbPath}?mode=ro`, PEER_SNAPSHOT_SQL],
            // 5,000 IDs are ~60 KB; 16 MB is over a million.
            { timeout: 3000, maxBuffer: 16 * 1024 * 1024 },
          );
          return parsePeerIds(stdout);
        },
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined,
      );
    }
    return this._hbbsPeers;
  }

  /**
   * Liveness from two sources: the agent heartbeat (lastSeenAt) and hbbs.
   * A machine RustDesk can reach is online even when its agent is silent —
   * calling it offline sent operators to the machine for nothing. hbbs being
   * unreachable degrades to heartbeat-only, exactly the old behaviour.
   * lastSeenAt stays the agent's own check-in, so a dead agent is still
   * visible on the device page.
   */
  // The window is common/connectivity.ts's HEARTBEAT_STALE_MS, which the console's
  // "agent silent" state uses too (0.35). The rule itself is unchanged.
  async markStaleEndpointsOffline(thresholdMinutes = HEARTBEAT_STALE_MS / 60_000) {
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

/**
 * A signed agent asked to "check now" (the reinstall flag, which it answers
 * with `rem0te-agent.exe update`) has done so once it reports an update check
 * newer than the dispatch. Without this the request stayed set until the
 * signed release's version equalled the portal's, which it need not ever do,
 * and the agent re-ran update every 30 minutes.
 */
function signedCheckedSince(dto: { updateChannel?: string; agentUpdateCheckedAt?: string }, dispatchedAt: Date): boolean {
  if (dto.updateChannel !== 'signed' || !dto.agentUpdateCheckedAt || !plausibleCheck(dto.agentUpdateCheckedAt)) return false;
  return new Date(dto.agentUpdateCheckedAt).getTime() > dispatchedAt.getTime();
}

/** A reported check time worth storing: not Go's zero time, not from the future. */
function plausibleCheck(v: string | undefined): boolean {
  if (!v) return false;
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t > Date.UTC(2024, 0, 1) && t < Date.now() + 24 * 3600_000;
}
