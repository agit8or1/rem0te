import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AppleDevice } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MdmSetupService } from '../setup/mdm-setup.service';
import { AppleEnrollmentService } from './apple-enrollment.service';
import { ApnsClient, type PushOutcome } from './apns';
import { MAX_CMS_BYTES, verifyDetachedCms } from './cms';
import { buildPlist, parsePlist, type PlistDict } from './plist';
import {
  COMMAND_TTL_MS, commandEnvelope, inventoryFrom, isRequestType, platformOf, readCheckin, readReport, REQUEST_TYPES, type RequestType,
} from './protocol';

/** The lowest OS Rem0te enrolls (docs/own-mdm.md decision 24). */
export const MIN_OS_MAJOR = 16;
/** Re-queue the inventory commands this often per enrolled device. */
export const INVENTORY_EVERY_MS = 24 * 3_600_000;
/** A device with queued commands is pushed again at most this often. */
export const REPUSH_MS = 60 * 60_000;
/** Bounds per sweep pass. */
export const PUSHES_PER_PASS = 100;
export const REFRESH_PER_PASS = 200;
/** The base64 Mdm-Signature header's ceiling (a CMS of at most MAX_CMS_BYTES). */
export const MAX_SIGNATURE_HEADER = Math.ceil((MAX_CMS_BYTES * 4) / 3) + 4;
export const LINK_ID_RE = /^ael[0-9a-f]{22}$/;

/** What a device endpoint answers. `body` is null for every refusal: the status says all a caller learns. */
export interface DeviceAnswer { status: number; body: Buffer | null }
const refuse = (status = 401): DeviceAnswer => ({ status, body: null });
const empty: DeviceAnswer = { status: 200, body: null };

/** For the driver: the Apple tables of one business, as plain rows. */
export interface AppleReader {
  devices(customerId: string, cursor: string | null, take: number): Promise<AppleDevice[]>;
  commands(customerId: string, cursor: string | null, take: number, since: Date): Promise<Array<{
    id: string; appleDeviceId: string; requestType: string; state: string; queuedAt: Date; sentAt: Date | null; respondedAt: Date | null; errorCode: string | null; expiresAt: Date;
  }>>;
}

/**
 * Rem0te's own Apple MDM server (0.84 Harbor, docs/own-mdm.md M2, §93).
 *
 * The device endpoints (`checkin`, `server`) verify the message's
 * Mdm-Signature against the device CA's certificates BEFORE the body is
 * parsed. A missing, malformed, untrusted or mismatching signature, an
 * unknown device, or a certificate that is not the one its device enrolled
 * with is 401 with no body. A device is the pair (UDID, certificate
 * SHA-256), bound at Authenticate, which must name a claimed enrollment link.
 *
 * Check-ins are always answered, under any containment pause (the design's
 * containment table: refusing them only makes a device retry and loses the
 * CheckOut). Pushes and inventory are not gated either: the table gates
 * lost-device and destructive commands (M4), and none exists here.
 *
 * The only writer of AppleDevice and AppleCommand. The queue holds the five
 * inventory request types and nothing else (protocol.ts REQUEST_TYPES, 0101's
 * CHECK). No command is built from anything a person or a device typed.
 */
@Injectable()
export class AppleMdmService implements AppleReader {
  private readonly logger = new Logger('AppleMdm');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly setup: MdmSetupService,
    private readonly enrollment: AppleEnrollmentService,
  ) {}

  /** Mdm-Signature, verified before anything is parsed. Returns the signer's certificate SHA-256, or null. */
  private async verified(raw: Buffer | undefined, header: string | string[] | undefined, now: Date): Promise<{ sha256: string; notAfter: Date; digest: string } | null> {
    if (!Buffer.isBuffer(raw) || !raw.length) return null;
    if (typeof header !== 'string' || !header.length || header.length > MAX_SIGNATURE_HEADER) return null;
    const compact = header.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
    const trust = await this.setup.deviceTrust();
    if (!trust) return null;
    const v = verifyDetachedCms(Buffer.from(compact, 'base64'), raw, trust, now);
    if (!v.ok) return null;
    return { sha256: v.signerSha256, notAfter: new Date(v.signer.validTo), digest: v.digest };
  }

  private parse(raw: Buffer): PlistDict | null {
    try { return parsePlist(raw); } catch { return null; }
  }

  // ── PUT /mdm/apple/checkin ──────────────────────────────────────────────

  async checkin(raw: Buffer | undefined, signature: string | string[] | undefined, enroll: unknown, ip: string | undefined): Promise<DeviceAnswer> {
    const now = new Date();
    const signer = await this.verified(raw, signature, now);
    if (!signer) return refuse();
    const d = this.parse(raw as Buffer);
    if (!d) return refuse(400);
    const m = readCheckin(d);
    if (m.type === 'invalid') return refuse(400);
    // Messages this release does not implement (DeclarativeManagement, bootstrap tokens…): nothing is stored.
    if (m.type === 'unsupported') return refuse(400);

    if (m.type === 'Authenticate') {
      if (typeof enroll !== 'string' || !LINK_ID_RE.test(enroll)) return refuse();
      const ready = await this.setup.enrollmentReadiness(now);
      if (!ready.ready || m.topic !== ready.topic) return refuse();
      const platform = platformOf(m.facts.productName);
      const major = Number((m.facts.osVersion ?? '').split('.')[0]);
      if (!platform || !Number.isInteger(major) || major < MIN_OS_MAJOR) return refuse(403);
      const out = await this.prisma.$transaction(async (tx) => {
        const link = await this.enrollment.consume(tx, enroll, now);
        if (!link) return null;
        // Enrolling again supersedes the device's previous enrollment, wherever it was.
        const old = await tx.appleDevice.findMany({ where: { udid: m.udid, state: { not: 'checked_out' } }, select: { id: true } });
        if (old.length) {
          await tx.appleCommand.updateMany({ where: { appleDeviceId: { in: old.map((o) => o.id) }, state: { in: ['queued', 'sent'] } }, data: { state: 'cancelled' } });
          await tx.appleDevice.updateMany({ where: { id: { in: old.map((o) => o.id) } }, data: { state: 'checked_out', checkedOutAt: now, checkoutReason: 'superseded', pushToken: null, pushMagic: null } });
        }
        if (await tx.appleDevice.findUnique({ where: { certSha256: signer.sha256 }, select: { id: true } })) return null;
        return tx.appleDevice.create({
          data: {
            tenantId: link.tenantId, customerId: link.customerId, linkId: enroll, udid: m.udid, certSha256: signer.sha256, certNotAfter: signer.notAfter, signatureDigest: signer.digest,
            topic: m.topic, state: 'authenticated', authenticatedAt: now, lastSeenAt: now, platform,
            productName: m.facts.productName, osVersion: m.facts.osVersion, buildVersion: m.facts.buildVersion,
            // Profile enrollment is corporate only (the link's ownership), so the serial is kept (0096's rule).
            serialNumber: m.facts.serialNumber, deviceName: m.facts.deviceName,
          },
          select: { id: true, tenantId: true, customerId: true },
        });
      }).catch(() => null);
      if (!out) return refuse();
      await this.audit.log({
        action: 'MDM_APPLE_DEVICE_AUTHENTICATED', actorIp: ip, tenantId: out.tenantId, customerId: out.customerId, resource: 'apple_device', resourceId: out.id,
        meta: { linkId: enroll, platform, osMajor: major },
      });
      return empty;
    }

    const dev = await this.prisma.appleDevice.findFirst({ where: { udid: m.udid, certSha256: signer.sha256, state: { not: 'checked_out' } } });
    if (!dev || dev.topic !== m.topic) return refuse();

    if (m.type === 'TokenUpdate') {
      const first = dev.state === 'authenticated';
      const r = await this.prisma.appleDevice.updateMany({
        where: { id: dev.id, state: { not: 'checked_out' } },
        data: { state: 'enrolled', enrolledAt: dev.enrolledAt ?? now, pushToken: m.pushToken, pushMagic: m.pushMagic, pushTokenInvalidAt: null, lastSeenAt: now, signatureDigest: signer.digest },
      });
      if (r.count !== 1) return refuse();
      if (first) {
        await this.audit.log({ action: 'MDM_APPLE_DEVICE_ENROLLED', actorIp: ip, tenantId: dev.tenantId, customerId: dev.customerId, resource: 'apple_device', resourceId: dev.id, meta: { platform: dev.platform } });
        await this.queueInventory(dev, now);
      }
      return empty;
    }

    // CheckOut: the device left management (the profile was removed). Final.
    await this.prisma.$transaction([
      this.prisma.appleCommand.updateMany({ where: { appleDeviceId: dev.id, state: { in: ['queued', 'sent'] } }, data: { state: 'cancelled' } }),
      this.prisma.appleDevice.updateMany({ where: { id: dev.id, state: { not: 'checked_out' } }, data: { state: 'checked_out', checkedOutAt: now, checkoutReason: 'checkout', pushToken: null, pushMagic: null, lastSeenAt: now, signatureDigest: signer.digest } }),
    ]);
    await this.audit.log({ action: 'MDM_APPLE_DEVICE_CHECKED_OUT', actorIp: ip, tenantId: dev.tenantId, customerId: dev.customerId, resource: 'apple_device', resourceId: dev.id });
    return empty;
  }

  // ── PUT /mdm/apple/server ───────────────────────────────────────────────

  async server(raw: Buffer | undefined, signature: string | string[] | undefined): Promise<DeviceAnswer> {
    const now = new Date();
    const signer = await this.verified(raw, signature, now);
    if (!signer) return refuse();
    const d = this.parse(raw as Buffer);
    if (!d) return refuse(400);
    const r = readReport(d);
    if (r.status === 'invalid') return refuse(400);
    const dev = await this.prisma.appleDevice.findFirst({ where: { udid: r.udid, certSha256: signer.sha256, state: 'enrolled' } });
    if (!dev) return refuse();
    await this.prisma.appleDevice.update({ where: { id: dev.id }, data: { lastSeenAt: now, signatureDigest: signer.digest } });

    if (r.status !== 'Idle') {
      const cmd = await this.prisma.appleCommand.findFirst({ where: { commandUuid: r.commandUuid.toUpperCase(), appleDeviceId: dev.id, state: 'sent' } });
      if (cmd && isRequestType(cmd.requestType)) {
        if (r.status === 'NotNow') {
          // The device is busy (locked, on a call). It asks again when it can; nothing more is sent this time.
          await this.prisma.appleCommand.updateMany({ where: { id: cmd.id, state: 'sent' }, data: { state: 'queued', notNowCount: { increment: 1 } } });
          return empty;
        }
        if (r.status === 'Acknowledged') {
          const inv = inventoryFrom(cmd.requestType, r.body);
          const moved = await this.prisma.appleCommand.updateMany({ where: { id: cmd.id, state: 'sent' }, data: { state: 'acknowledged', respondedAt: now } });
          if (moved.count === 1) {
            await this.prisma.appleDevice.update({
              where: { id: dev.id },
              data: { ...inv, ...(inv.productName ? { platform: platformOf(inv.productName) ?? dev.platform } : {}), ...(cmd.requestType === 'DeviceInformation' ? { lastInventoryAt: now } : {}) },
            });
          }
        } else {
          await this.prisma.appleCommand.updateMany({ where: { id: cmd.id, state: 'sent' }, data: { state: 'error', respondedAt: now, errorCode: (r.errorCode ?? 'apple:unknown').slice(0, 64) } });
        }
        await this.audit.log({
          action: 'MDM_APPLE_COMMAND_RESULT', tenantId: dev.tenantId, customerId: dev.customerId, resource: 'apple_command', resourceId: cmd.id,
          meta: { requestType: cmd.requestType, status: r.status, errorCode: r.status === 'Acknowledged' ? null : r.errorCode },
        });
      }
    }
    return this.next(dev, now);
  }

  /** The device's oldest queued, unexpired command, marked sent conditionally; or an empty 200. */
  private async next(dev: AppleDevice, now: Date): Promise<DeviceAnswer> {
    for (let i = 0; i < 3; i++) {
      const c = await this.prisma.appleCommand.findFirst({ where: { appleDeviceId: dev.id, state: 'queued', expiresAt: { gt: now } }, orderBy: { queuedAt: 'asc' } });
      if (!c || !isRequestType(c.requestType)) return empty;
      const r = await this.prisma.appleCommand.updateMany({ where: { id: c.id, state: 'queued' }, data: { state: 'sent', sentAt: now } });
      if (r.count === 1) return { status: 200, body: Buffer.from(buildPlist(commandEnvelope(c.requestType, c.commandUuid)), 'utf8') };
    }
    return empty;
  }

  /** Queue the five inventory commands. An open command of a type is never stacked (0101's partial unique index). */
  async queueInventory(dev: Pick<AppleDevice, 'id' | 'tenantId' | 'customerId'>, now: Date): Promise<number> {
    const r = await this.prisma.appleCommand.createMany({
      data: REQUEST_TYPES.map((t: RequestType) => ({
        tenantId: dev.tenantId, customerId: dev.customerId, appleDeviceId: dev.id, commandUuid: randomUUID().toUpperCase(), requestType: t,
        queuedAt: now, expiresAt: new Date(now.getTime() + COMMAND_TTL_MS),
      })),
      skipDuplicates: true,
    });
    await this.prisma.appleDevice.update({ where: { id: dev.id }, data: { lastInventoryQueuedAt: now } });
    return r.count;
  }

  // ── The sweep's part (MdmSyncService calls pass(); MDM_SWEEP=off stops it) ─

  /** Expire, refresh, push. Never throws. */
  async pass(now = new Date()): Promise<{ expiredLinks: number; expiredCommands: number; queued: number; pushed: number }> {
    const out = { expiredLinks: 0, expiredCommands: 0, queued: 0, pushed: 0 };
    try {
      out.expiredLinks = await this.enrollment.expirePass(now);
      out.expiredCommands = (await this.prisma.appleCommand.updateMany({ where: { state: { in: ['queued', 'sent'] }, expiresAt: { lt: now } }, data: { state: 'expired' } })).count;
      const stale = await this.prisma.appleDevice.findMany({
        where: { state: 'enrolled', OR: [{ lastInventoryQueuedAt: null }, { lastInventoryQueuedAt: { lt: new Date(now.getTime() - INVENTORY_EVERY_MS) } }] },
        select: { id: true, tenantId: true, customerId: true }, take: REFRESH_PER_PASS, orderBy: { lastInventoryQueuedAt: { sort: 'asc', nulls: 'first' } },
      });
      for (const d of stale) out.queued += await this.queueInventory(d, now);
      out.pushed = await this.pushPass(now);
    } catch (e) {
      this.logger.warn(`pass: ${(e as Error).name}`);
    }
    return out;
  }

  /**
   * Wake devices that have commands waiting: one APNs connection for the
   * pass, the push identity opened in memory only for it. A device is pushed
   * when it has a queued command never pushed, or again after REPUSH_MS.
   * An unregistered or bad token stops pushing that device until its next
   * TokenUpdate; a refused certificate or topic stops the pass.
   */
  async pushPass(now: Date): Promise<number> {
    const due = await this.prisma.appleDevice.findMany({
      where: {
        state: 'enrolled', pushToken: { not: null }, pushTokenInvalidAt: null,
        commands: { some: { state: 'queued', expiresAt: { gt: now } } },
        OR: [{ lastPushAt: null }, { lastPushAt: { lt: new Date(now.getTime() - REPUSH_MS) } }, { commands: { some: { state: 'queued', pushedAt: null } } }],
      },
      take: PUSHES_PER_PASS, orderBy: { lastPushAt: { sort: 'asc', nulls: 'first' } },
    });
    if (!due.length) return 0;
    const identity = await this.setup.openPushIdentity(now);
    if (!identity) return 0;
    let client: ApnsClient;
    try { client = await ApnsClient.open(identity); }
    catch (e) {
      this.logger.warn(`apns: ${(e as Error).name}`);
      await this.prisma.appleDevice.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { lastPushAt: now, lastPushResult: 'unreachable' } });
      return 0;
    }
    let pushed = 0;
    try {
      for (const d of due) {
        if (!d.pushToken || !d.pushMagic || !client.usable) break;
        let o: PushOutcome;
        try { o = await client.push(d.pushToken, d.pushMagic); } catch { o = { result: 'retry', status: 0, reason: null }; }
        const result = o.result === 'retry' && 'status' in o && o.status === 0 ? 'unreachable' : o.result;
        await this.prisma.appleDevice.update({
          where: { id: d.id },
          data: {
            lastPushAt: now, lastPushResult: result,
            ...(o.result === 'ok' ? { lastPushOkAt: now } : {}),
            ...(o.result === 'unregistered' || o.result === 'bad_token' ? { pushTokenInvalidAt: now } : {}),
          },
        });
        if (o.result === 'ok') {
          pushed++;
          await this.prisma.appleCommand.updateMany({ where: { appleDeviceId: d.id, state: 'queued', pushedAt: null }, data: { pushedAt: now } });
        }
        await this.audit.log({
          action: 'MDM_APPLE_PUSHED', tenantId: d.tenantId, customerId: d.customerId, resource: 'apple_device', resourceId: d.id,
          meta: { result, status: 'status' in o ? o.status : 200 },
        });
        if (o.result === 'certificate_refused' || o.result === 'topic_refused') break;
      }
    } finally {
      client.close();
    }
    return pushed;
  }

  // ── Reads (the apple driver, and the admin list) ────────────────────────

  devices(customerId: string, cursor: string | null, take: number) {
    return this.prisma.appleDevice.findMany({ where: { customerId, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take });
  }

  commands(customerId: string, cursor: string | null, take: number, since: Date) {
    return this.prisma.appleCommand.findMany({
      where: { customerId, queuedAt: { gte: since }, ...(cursor ? { id: { gt: cursor } } : {}) }, orderBy: { id: 'asc' }, take,
      select: { id: true, appleDeviceId: true, requestType: true, state: true, queuedAt: true, sentAt: true, respondedAt: true, errorCode: true, expiresAt: true },
    });
  }

  /** Businesses with an Apple enrollment and no `apple` connector yet: the sync creates one each (§93). */
  async businessesNeedingConnector(): Promise<Array<{ customerId: string; tenantId: string }>> {
    const rows = await this.prisma.appleDevice.findMany({
      where: { customer: { mdmConnectors: { none: { provider: 'apple' } } } }, distinct: ['customerId'], select: { customerId: true, tenantId: true }, take: 100,
    });
    return rows;
  }

  /** Platform Admin view (AppleAdminController): no push token or magic, ever. */
  async adminList(q: { businessId?: string }) {
    const rows = await this.prisma.appleDevice.findMany({
      where: q.businessId ? { customerId: q.businessId } : {}, orderBy: { createdAt: 'desc' }, take: 200,
      select: {
        id: true, customerId: true, state: true, platform: true, deviceName: true, productName: true, osVersion: true, serialNumber: true,
        authenticatedAt: true, enrolledAt: true, checkedOutAt: true, checkoutReason: true, lastSeenAt: true, lastPushAt: true, lastPushOkAt: true,
        lastPushResult: true, lastInventoryAt: true, certNotAfter: true, signatureDigest: true, customer: { select: { name: true } },
        commands: { orderBy: { queuedAt: 'desc' }, take: 10, select: { requestType: true, state: true, queuedAt: true, sentAt: true, respondedAt: true, errorCode: true } },
      },
    });
    return rows.map(({ customer, ...r }) => ({ ...r, businessName: customer.name }));
  }
}
