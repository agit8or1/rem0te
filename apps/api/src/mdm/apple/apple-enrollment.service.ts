import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { testLoopbackAllowed } from '../../common/safe-https';
import { PublicUrlService } from '../../platform/public-url.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ActorContext } from '../../rbac/access-control.service';
import { MdmSetupService } from '../setup/mdm-setup.service';
import { buildProfile, scepTestIdentity, signProfile, type Identity } from './profile';

/** How long a link may live (0101 CHECK: 15 minutes to 24 hours). Default an hour. */
export const LINK_MIN_MINUTES = 15;
export const LINK_MAX_MINUTES = 24 * 60;
export const LINK_DEFAULT_MINUTES = 60;
/** After the profile is downloaded, the device has this long to send its Authenticate. */
export const AUTHENTICATE_WINDOW_MS = 60 * 60_000;
/** The ACME directory path the profile names: step-ca's `rem0te-mdm` provisioner, through Caddy's one route. */
export const ACME_DIRECTORY_PATH = '/acme/rem0te-mdm/directory';
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const tokenHash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/**
 * One-time Apple enrollment links (0.84 Harbor, docs/own-mdm.md M2, §93).
 * The only writer of AppleEnrollmentLink.
 *
 *   create   a Platform Admin (the controller's class guard), after
 *            assertFresh naming mdm.enroll; refused until the push
 *            certificate, the device CA and the profile signer are in place.
 *            32 random bytes, returned ONCE in the link; only the SHA-256 is
 *            stored. Audited (logOrFail) before the row.
 *   claim    the public download (GET …/enroll/<token>). Readiness first, so
 *            a server that cannot make a profile never burns a link; then
 *            ONE conditional update (open → claimed, unexpired) with nothing
 *            read first, the claim-token rule (§34, §70). Only then is the
 *            row read, the profile built and signed.
 *   consume  the Authenticate that names the link (AppleMdmService, inside
 *            its transaction): claimed → used, once.
 *   revoke   never asks for a fresh confirmation; open or claimed → revoked.
 */
@Injectable()
export class AppleEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly setup: MdmSetupService,
    private readonly urls: PublicUrlService,
  ) {}

  /** The portal's public base for device URLs: https on a real server; the loopback API under NODE_ENV=test. */
  base(): string | null {
    const b = this.urls.api().replace(/\/+$/, '');
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored, bounded, one group starting with a literal colon
    if (/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{2,5})?$/.test(b)) return b;
    return testLoopbackAllowed(b) ? b : null;
  }

  async create(a: ActorContext, body: unknown) {
    const p = z.object({ businessId: z.string().min(1).max(64), expiresInMinutes: z.number().int().min(LINK_MIN_MINUTES).max(LINK_MAX_MINUTES).optional() }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: `Give businessId, and expiresInMinutes (${LINK_MIN_MINUTES} to ${LINK_MAX_MINUTES}) if not an hour.` });
    const ready = await this.setup.enrollmentReadiness();
    if (!ready.ready) throw new ConflictException({ code: ready.code, message: ready.message });
    const base = this.base();
    if (!base) throw new ConflictException({ code: 'PUBLIC_URL_NOT_HTTPS', message: 'The server\'s public address must be https (Settings → General): it goes into every enrolled device for good.' });
    const business = await this.prisma.customer.findUnique({ where: { id: p.data.businessId }, select: { id: true, tenantId: true, name: true } });
    if (!business) throw new NotFoundException({ code: 'BUSINESS_NOT_FOUND', message: 'No such business.' });
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (p.data.expiresInMinutes ?? LINK_DEFAULT_MINUTES) * 60_000);
    const id = `ael${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    await this.audit.logOrFail({
      action: 'MDM_APPLE_LINK_CREATED', actorId: a.userId, actorIp: a.ip, tenantId: business.tenantId, customerId: business.id,
      resource: 'apple_enrollment_link', resourceId: id, meta: { expiresAt: expiresAt.toISOString(), ownership: 'corporate' },
    });
    await this.prisma.appleEnrollmentLink.create({
      data: { id, tenantId: business.tenantId, customerId: business.id, tokenSha256: tokenHash(token), createdById: a.userId, createdAt: now, expiresAt },
    });
    return { id, businessId: business.id, businessName: business.name, expiresAt, url: `${base}/api/v1/mdm/apple/enroll/${token}`, shownOnce: true };
  }

  async list(q: { businessId?: string }) {
    const rows = await this.prisma.appleEnrollmentLink.findMany({
      where: q.businessId ? { customerId: q.businessId } : {}, orderBy: { createdAt: 'desc' }, take: 100,
      select: {
        id: true, customerId: true, state: true, ownership: true, createdAt: true, expiresAt: true, claimedAt: true, usedAt: true, revokedAt: true, createdById: true,
        customer: { select: { name: true } }, device: { select: { id: true, state: true, deviceName: true } },
      },
    });
    return rows.map(({ customer, ...r }) => ({ ...r, businessName: customer.name }));
  }

  async revoke(a: ActorContext, id: string) {
    const now = new Date();
    const r = await this.prisma.appleEnrollmentLink.updateMany({ where: { id, state: { in: ['open', 'claimed'] } }, data: { state: 'revoked', revokedAt: now, revokedById: a.userId } });
    if (r.count !== 1) throw new NotFoundException({ code: 'LINK_NOT_REVOCABLE', message: 'No open enrollment link with that id (it may already be used, expired or revoked).' });
    const row = await this.prisma.appleEnrollmentLink.findUnique({ where: { id }, select: { tenantId: true, customerId: true } });
    await this.audit.log({ action: 'MDM_APPLE_LINK_REVOKED', actorId: a.userId, actorIp: a.ip, tenantId: row?.tenantId, customerId: row?.customerId, resource: 'apple_enrollment_link', resourceId: id });
    return { revoked: true };
  }

  /**
   * The public download. Returns the signed profile, or null for any link
   * that cannot be claimed (unknown, used, expired, revoked): one answer for
   * all of them.
   */
  async claim(token: string, ip: string | undefined): Promise<{ body: Buffer; filename: string } | null> {
    if (!TOKEN_RE.test(token)) return null;
    const ready = await this.setup.enrollmentReadiness();
    if (!ready.ready) throw new ServiceUnavailableException({ code: 'ENROLLMENT_NOT_READY', message: 'This server is not ready to enroll devices yet. Ask your administrator.' });
    const base = this.base();
    const signer = await this.setup.openProfileSigner();
    if (!base || !signer) throw new ServiceUnavailableException({ code: 'ENROLLMENT_NOT_READY', message: 'This server is not ready to enroll devices yet. Ask your administrator.' });
    const now = new Date();
    const hash = tokenHash(token);
    // The claim: one conditional update, nothing read first.
    const claimed = await this.prisma.appleEnrollmentLink.updateMany({ where: { tokenSha256: hash, state: 'open', expiresAt: { gt: now } }, data: { state: 'claimed', claimedAt: now } });
    if (claimed.count !== 1) return null;
    const link = await this.prisma.appleEnrollmentLink.findUnique({ where: { tokenSha256: hash }, select: { id: true, tenantId: true, customerId: true, customer: { select: { name: true } } } });
    if (!link) return null;
    await this.audit.log({ action: 'MDM_APPLE_LINK_CLAIMED', actorIp: ip, tenantId: link.tenantId, customerId: link.customerId, resource: 'apple_enrollment_link', resourceId: link.id });
    const { plist } = buildProfile({ linkId: link.id, base, topic: ready.topic, identity: this.identity(base), organization: link.customer.name });
    return { body: signProfile(plist, signer, now), filename: 'rem0te-enroll.mobileconfig' };
  }

  /**
   * The device identity payload. ACME through step-ca on a real server. Under
   * NODE_ENV=test only, MDM_TEST_SCEP_URL / MDM_TEST_SCEP_CHALLENGE give the
   * device simulator a SCEP identity from the test stack's step-ca
   * (scepTestIdentity refuses anywhere else). Read here and nowhere else.
   */
  private identity(base: string): Identity {
    if (process.env.NODE_ENV === 'test' && process.env.MDM_TEST_SCEP_URL) {
      return scepTestIdentity(process.env.MDM_TEST_SCEP_URL, process.env.MDM_TEST_SCEP_CHALLENGE ?? '');
    }
    return { kind: 'acme', directoryUrl: `${base}${ACME_DIRECTORY_PATH}`, clientIdentifier: randomBytes(24).toString('base64url') };
  }

  /** The Authenticate that names this link: claimed (within the window) → used, once. Inside the caller's transaction. */
  async consume(tx: Prisma.TransactionClient, linkId: string, now: Date): Promise<{ tenantId: string; customerId: string } | null> {
    const r = await tx.appleEnrollmentLink.updateMany({
      where: { id: linkId, state: 'claimed', claimedAt: { gt: new Date(now.getTime() - AUTHENTICATE_WINDOW_MS) } },
      data: { state: 'used', usedAt: now },
    });
    if (r.count !== 1) return null;
    return tx.appleEnrollmentLink.findUnique({ where: { id: linkId }, select: { tenantId: true, customerId: true } });
  }

  /** Expire links nobody used: open past their expiry, claimed past the Authenticate window and the expiry. Bounded. */
  async expirePass(now: Date): Promise<number> {
    const a = await this.prisma.appleEnrollmentLink.updateMany({ where: { state: 'open', expiresAt: { lt: now } }, data: { state: 'expired' } });
    const b = await this.prisma.appleEnrollmentLink.updateMany({
      where: { state: 'claimed', expiresAt: { lt: now }, claimedAt: { lt: new Date(now.getTime() - AUTHENTICATE_WINDOW_MS) } }, data: { state: 'expired' },
    });
    return a.count + b.count;
  }
}
