import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as qrcode from 'qrcode';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { activePause } from '../../containment/pause';
import { PublicUrlService } from '../../platform/public-url.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { ActorContext } from '../../rbac/access-control.service';
import { MdmSetupService } from '../setup/mdm-setup.service';
import { ANDROID_TEST_REASON, type AndroidTestResult } from '../setup/setup-model';
import type { AndroidReader } from '../drivers/android';
import {
  AmapiError, callbackBase, createEnrollmentToken, createEnterprise, createSignupUrl, patchDefaultPolicy, probe, type AndroidCredential,
} from '../drivers/android/amapi';
import {
  ENTERPRISE_TOKEN_RE, PERSONAL_USAGE, SIGNUP_MINUTES, STATE_TOKEN_RE, TOKEN_DEFAULT_MINUTES, TOKEN_MAX_MINUTES, TOKEN_MIN_MINUTES,
} from '../drivers/android/shape';

export const CALLBACK_PATH = '/api/v1/mdm/android/signup/callback';
/** Where the admin's browser lands after Google's redirect (same origin; Caddy routes /api/* to the API and the rest to the web). */
export const RETURN_PATH = '/settings/mobile-devices';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const stateHash = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

/** What a failed sign-up records (0102: [a-z0-9_]{1,40}) and what the page says about it. */
export const SIGNUP_FAILURES = {
  signup_not_found: 'That sign-up link is unknown, already used or expired. Start again from Settings → Mobile devices.',
  admin_gone: 'The Platform Admin who started this sign-up is no longer an active Platform Admin.',
  already_bound: 'That business already has an Android enterprise.',
  paused: 'An integration pause is in effect for that business: nothing is sent to Google.',
  no_key: 'The service-account key is no longer sealed in Rem0te.',
  bad_token: 'Google\'s answer did not carry a usable enterprise token.',
  google_refused: 'Google refused to create the enterprise.',
  google_unreachable: 'Google could not be reached to create the enterprise. Start again.',
  google_bad_response: 'Google answered something Rem0te did not expect.',
  enterprise_taken: 'Google returned an enterprise already bound to another business.',
} as const;
export type SignupFailure = keyof typeof SIGNUP_FAILURES;

/**
 * Rem0te as the EMM for Android (0.85 Mooring, docs/own-mdm.md M3, §94):
 * wizard steps 3, 5 and 6 and the `android` driver's reader. The only
 * writer of AndroidSignup and AndroidEnterprise, and the only caller of the
 * drivers/android client outside the driver itself.
 *
 *   test            Platform Admin, assertFresh naming mdm.setup (the
 *                   controller). A global `integration` pause refuses it
 *                   before the key is opened. A token and one read call;
 *                   the outcome is recorded for the key tested.
 *   startSignup     the same, plus the business's own `integration` pause, a
 *                   passed test, and no enterprise yet. 32 random bytes of
 *                   state, only its SHA-256 stored, at most 30 minutes, bound
 *                   to the business and the Platform Admin.
 *   callback        @Public: Google's redirect of the admin's browser. ONE
 *                   conditional update claims the state (open → claimed,
 *                   unexpired) with nothing read first; then the admin must
 *                   still be an active Platform Admin, the business unbound,
 *                   no pause; enterprises.create; logOrFail; the enterprise
 *                   and the sign-up's `bound` in one transaction; then the
 *                   default policy. Every outcome redirects to the settings
 *                   page with a code, never Google's text.
 *   applyPolicy     re-applies the default policy (mdm.setup).
 *   createToken     a one-time enrollment token (mdm.enroll), an hour by
 *                   default; work profile or fully managed per token. The
 *                   value is returned once and never stored; the audit row
 *                   (logOrFail, before it is returned) carries ids only.
 *
 * Every outbound call consults the `integration` pause first. Audit rows
 * carry ids, kinds and outcome codes: never a key, a token, a state or a URL.
 */
@Injectable()
export class AndroidEmmService implements AndroidReader {
  private readonly logger = new Logger('AndroidEmm');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly setup: MdmSetupService,
    private readonly urls: PublicUrlService,
  ) {}

  // ── The driver's reader ─────────────────────────────────────────────────

  credential(): Promise<AndroidCredential | null> { return this.setup.openAndroidCredential(); }

  /**
   * The open commands Rem0te issued on this connector (0.86, decision 30):
   * the driver reads each one's Operation by name. Read-only; the sync
   * records what comes back.
   */
  async openCommands(connectorId: string, after: string | null, take: number) {
    const rows = await this.prisma.mdmCommand.findMany({
      where: { connectorId, origin: 'portal', state: { in: ['sent', 'acknowledged'] }, providerCommandId: { not: null, ...(after ? { gt: after } : {}) } },
      orderBy: { providerCommandId: 'asc' }, take, select: { providerCommandId: true, mobileDevice: { select: { managementScope: true } } },
    });
    return rows.map((r) => ({ providerCommandId: r.providerCommandId as string, managementScope: r.mobileDevice.managementScope }));
  }

  // ── The admin's view ────────────────────────────────────────────────────

  async view() {
    const [enterprises, signups] = await Promise.all([
      this.prisma.androidEnterprise.findMany({ orderBy: { boundAt: 'desc' }, take: 200, select: {
        id: true, customerId: true, enterpriseId: true, boundAt: true, boundById: true, policyId: true, policyVersion: true, policySetAt: true, customer: { select: { name: true } },
      } }),
      this.prisma.androidSignup.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: {
        id: true, customerId: true, state: true, createdAt: true, expiresAt: true, finishedAt: true, failureCode: true, createdById: true, customer: { select: { name: true } },
      } }),
    ]);
    const devices = await this.prisma.mobileDevice.groupBy({ by: ['customerId'], where: { provider: 'android', enrollmentState: 'enrolled' }, _count: { _all: true } });
    const count = new Map(devices.map((d) => [d.customerId, d._count._all]));
    return {
      enterprises: enterprises.map(({ customer, ...e }) => ({ ...e, businessName: customer.name, devicesEnrolled: count.get(e.customerId) ?? 0 })),
      signups: signups.map(({ customer, ...s }) => ({ ...s, businessName: customer.name })),
      tokenMinutes: { min: TOKEN_MIN_MINUTES, max: TOKEN_MAX_MINUTES, default: TOKEN_DEFAULT_MINUTES },
      personalUsage: PERSONAL_USAGE,
      provenAgainstGoogle: false,
    };
  }

  // ── Step 3: the connection test ─────────────────────────────────────────

  async test(a: ActorContext) {
    if (await activePause(this.prisma, 'integration', null)) throw new ConflictException({ code: 'INTEGRATION_PAUSED', message: 'A global integration pause is in effect: nothing is sent to Google.' });
    const c = await this.setup.openAndroidCredential();
    if (!c) throw new ConflictException({ code: 'NO_ANDROID_KEY', message: 'Upload the service-account key first (step 2).' });
    let result: AndroidTestResult = 'ok';
    try { await probe(c); } catch (e) { result = testResult(e); }
    await this.audit.log({ action: 'MDM_ANDROID_TESTED', actorId: a.userId, actorIp: a.ip, resource: 'mdm_setup', resourceId: 'platform', meta: { result, projectId: c.projectId, keyIdLast4: c.keyIdLast4 } });
    await this.setup.recordAndroidTest(c.keyIdLast4, result);
    return { result, message: ANDROID_TEST_REASON[result], setup: await this.setup.view() };
  }

  // ── Step 5: bind a business ─────────────────────────────────────────────

  async startSignup(a: ActorContext, body: unknown) {
    const p = z.object({ businessId: z.string().regex(ID_RE) }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Give businessId.' });
    const business = await this.prisma.customer.findUnique({ where: { id: p.data.businessId }, select: { id: true, tenantId: true, name: true, androidEnterprise: { select: { id: true } } } });
    if (!business) throw new NotFoundException({ code: 'BUSINESS_NOT_FOUND', message: 'No such business.' });
    if (business.androidEnterprise) throw new ConflictException({ code: 'ENTERPRISE_BOUND', message: 'That business already has an Android enterprise.' });
    const view = await this.setup.view();
    if (view.android.connectionTest?.result !== 'ok') throw new ConflictException({ code: 'ANDROID_TEST_FIRST', message: 'Run the connection test first (step 3); it must pass.' });
    if (await activePause(this.prisma, 'integration', business.id)) throw new ConflictException({ code: 'INTEGRATION_PAUSED', message: 'An integration pause is in effect for this business: nothing is sent to Google.' });
    const base = callbackBase(this.urls.api());
    if (!base) throw new ConflictException({ code: 'PUBLIC_URL_NOT_HTTPS', message: 'The server\'s public address must be https (Settings → General): Google redirects the admin back to it.' });
    const c = await this.setup.openAndroidCredential();
    if (!c) throw new ConflictException({ code: 'NO_ANDROID_KEY', message: 'Upload the service-account key first (step 2).' });
    const state = randomBytes(32).toString('base64url');
    const now = new Date();
    const id = `asu${randomUUID().replace(/-/g, '').slice(0, 22)}`;
    let signup: { name: string; url: string };
    try { signup = await createSignupUrl(c, `${base}${CALLBACK_PATH}?state=${state}`); }
    catch (e) { throw googleError(e); }
    const expiresAt = new Date(now.getTime() + SIGNUP_MINUTES * 60_000);
    await this.audit.logOrFail({
      action: 'MDM_ANDROID_SIGNUP_STARTED', actorId: a.userId, actorIp: a.ip, tenantId: business.tenantId, customerId: business.id,
      resource: 'android_signup', resourceId: id, meta: { expiresAt: expiresAt.toISOString() },
    });
    await this.prisma.androidSignup.create({
      data: { id, tenantId: business.tenantId, customerId: business.id, stateSha256: stateHash(state), signupUrlName: signup.name, createdById: a.userId, createdAt: now, expiresAt },
    });
    return { id, businessId: business.id, businessName: business.name, url: signup.url, expiresAt, shownOnce: true };
  }

  /**
   * Google's redirect. Returns where to send the browser: the settings page
   * with `android=bound` or `android=failed&code=…`. Never throws.
   */
  async callback(stateRaw: unknown, tokenRaw: unknown, ip: string | undefined): Promise<string> {
    const back = (q: Record<string, string>) => `${RETURN_PATH}?${new URLSearchParams(q).toString()}`;
    const state = typeof stateRaw === 'string' && STATE_TOKEN_RE.test(stateRaw) ? stateRaw : null;
    if (!state) return back({ android: 'failed', code: 'signup_not_found' });
    const now = new Date();
    const hash = stateHash(state);
    // The claim: one conditional update, nothing read first.
    let claimed;
    try {
      claimed = await this.prisma.androidSignup.updateMany({ where: { stateSha256: hash, state: 'open', expiresAt: { gt: now } }, data: { state: 'claimed', claimedAt: now } });
    } catch (e) { this.logger.warn(`callback claim: ${(e as Error).name}`); return back({ android: 'failed', code: 'signup_not_found' }); }
    if (claimed.count !== 1) return back({ android: 'failed', code: 'signup_not_found' });
    const s = await this.prisma.androidSignup.findUnique({ where: { stateSha256: hash }, select: { id: true, tenantId: true, customerId: true, signupUrlName: true, createdById: true } });
    if (!s) return back({ android: 'failed', code: 'signup_not_found' });
    const fail = async (code: SignupFailure) => {
      await this.prisma.androidSignup.updateMany({ where: { id: s.id, state: 'claimed' }, data: { state: 'failed', finishedAt: new Date(), failureCode: code } }).catch(() => undefined);
      await this.audit.log({ action: 'MDM_ANDROID_SIGNUP_FAILED', actorId: s.createdById, actorIp: ip, tenantId: s.tenantId, customerId: s.customerId, resource: 'android_signup', resourceId: s.id, meta: { code } });
      return back({ android: 'failed', code, business: s.customerId });
    };
    try {
      const admin = await this.prisma.user.findUnique({ where: { id: s.createdById }, select: { isPlatformAdmin: true, status: true } });
      if (!admin?.isPlatformAdmin || admin.status !== 'ACTIVE') return await fail('admin_gone');
      if (await this.prisma.androidEnterprise.findUnique({ where: { customerId: s.customerId }, select: { id: true } })) return await fail('already_bound');
      if (await activePause(this.prisma, 'integration', s.customerId)) return await fail('paused');
      const token = typeof tokenRaw === 'string' && ENTERPRISE_TOKEN_RE.test(tokenRaw) ? tokenRaw : null;
      if (!token) return await fail('bad_token');
      const c = await this.setup.openAndroidCredential();
      if (!c) return await fail('no_key');
      let enterpriseId: string;
      try { enterpriseId = await createEnterprise(c, s.signupUrlName, token); }
      catch (e) { return await fail(e instanceof AmapiError ? (e.code === 'unreachable' ? 'google_unreachable' : e.code === 'bad_response' ? 'google_bad_response' : 'google_refused') : 'google_unreachable'); }
      if (await this.prisma.androidEnterprise.findUnique({ where: { enterpriseId }, select: { id: true } })) return await fail('enterprise_taken');
      await this.audit.logOrFail({
        action: 'MDM_ANDROID_ENTERPRISE_BOUND', actorId: s.createdById, actorIp: ip, tenantId: s.tenantId, customerId: s.customerId,
        resource: 'android_enterprise', resourceId: enterpriseId, meta: { signupId: s.id, enterpriseId },
      });
      const bound = new Date();
      await this.prisma.$transaction(async (tx) => {
        const w = await tx.androidSignup.updateMany({ where: { id: s.id, state: 'claimed' }, data: { state: 'bound', finishedAt: bound, enterpriseId } });
        if (w.count !== 1) throw new ConflictException({ code: 'SIGNUP_CHANGED' });
        await tx.androidEnterprise.create({ data: { tenantId: s.tenantId, customerId: s.customerId, enterpriseId, signupId: s.id, boundById: s.createdById, boundAt: bound } });
      });
      const policy = await this.policy(s.customerId, s.createdById, ip).then(() => 'set', () => 'not_set');
      return back({ android: 'bound', business: s.customerId, policy });
    } catch (e) {
      this.logger.warn(`callback: ${(e as Error).name}`);
      return fail('google_unreachable').catch(() => back({ android: 'failed', code: 'google_unreachable' }));
    }
  }

  // ── Step 6: the default policy and enrollment tokens ────────────────────

  async applyPolicy(a: ActorContext, businessId: string) {
    if (!ID_RE.test(businessId)) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'That is not a business id.' });
    return this.policy(businessId, a.userId, a.ip);
  }

  /** policies.patch of the default policy: exactly DEFAULT_POLICY (software and app reports only). */
  private async policy(customerId: string, actorId: string, ip: string | undefined) {
    const e = await this.prisma.androidEnterprise.findUnique({ where: { customerId } });
    if (!e) throw new NotFoundException({ code: 'NO_ENTERPRISE', message: 'That business has no Android enterprise yet (step 5).' });
    if (await activePause(this.prisma, 'integration', customerId)) throw new ConflictException({ code: 'INTEGRATION_PAUSED', message: 'An integration pause is in effect for this business: nothing is sent to Google.' });
    const c = await this.setup.openAndroidCredential();
    if (!c) throw new ConflictException({ code: 'NO_ANDROID_KEY', message: 'Upload the service-account key first (step 2).' });
    let version: string;
    try { version = await patchDefaultPolicy(c, e.enterpriseId); } catch (err) { throw googleError(err); }
    await this.audit.log({
      action: 'MDM_ANDROID_POLICY_SET', actorId, actorIp: ip, tenantId: e.tenantId, customerId, resource: 'android_enterprise', resourceId: e.enterpriseId,
      meta: { policyId: e.policyId, version, softwareInfo: true, applicationReports: true, networkInfo: false },
    });
    await this.prisma.androidEnterprise.update({ where: { id: e.id }, data: { policyVersion: version, policySetAt: new Date() } });
    return { businessId: customerId, enterpriseId: e.enterpriseId, policyId: e.policyId, policyVersion: version };
  }

  async createToken(a: ActorContext, body: unknown) {
    const p = z.object({
      businessId: z.string().regex(ID_RE),
      personalUsage: z.enum(PERSONAL_USAGE),
      expiresInMinutes: z.number().int().min(TOKEN_MIN_MINUTES).max(TOKEN_MAX_MINUTES).optional(),
    }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: `Give businessId, personalUsage (allowed: a work profile; disallowed: fully managed) and expiresInMinutes (${TOKEN_MIN_MINUTES} to ${TOKEN_MAX_MINUTES}) if not an hour.` });
    const e = await this.prisma.androidEnterprise.findUnique({ where: { customerId: p.data.businessId }, include: { customer: { select: { name: true } } } });
    if (!e) throw new NotFoundException({ code: 'NO_ENTERPRISE', message: 'That business has no Android enterprise yet (step 5).' });
    if (!e.policySetAt) throw new ConflictException({ code: 'POLICY_FIRST', message: 'Apply the default policy first (step 6).' });
    if (await activePause(this.prisma, 'integration', e.customerId)) throw new ConflictException({ code: 'INTEGRATION_PAUSED', message: 'An integration pause is in effect for this business: nothing is sent to Google.' });
    const c = await this.setup.openAndroidCredential();
    if (!c) throw new ConflictException({ code: 'NO_ANDROID_KEY', message: 'Upload the service-account key first (step 2).' });
    const minutes = p.data.expiresInMinutes ?? TOKEN_DEFAULT_MINUTES;
    let t: Awaited<ReturnType<typeof createEnrollmentToken>>;
    try { t = await createEnrollmentToken(c, e.enterpriseId, p.data.personalUsage, minutes); } catch (err) { throw googleError(err); }
    const expiresAt = t.expiresAt ? new Date(t.expiresAt) : new Date(Date.now() + minutes * 60_000);
    await this.audit.logOrFail({
      action: 'MDM_ANDROID_TOKEN_CREATED', actorId: a.userId, actorIp: a.ip, tenantId: e.tenantId, customerId: e.customerId,
      resource: 'android_enrollment_token', resourceId: t.tokenId, meta: { enterpriseId: e.enterpriseId, personalUsage: p.data.personalUsage, oneTimeOnly: true, expiresAt: expiresAt.toISOString() },
    });
    const qrDataUrl = await qrcode.toDataURL(t.qrCode, { errorCorrectionLevel: 'M', margin: 2, width: 320 });
    return {
      businessId: e.customerId, businessName: e.customer.name, personalUsage: p.data.personalUsage, oneTimeOnly: true, expiresAt,
      value: t.value, qrDataUrl, shownOnce: true,
    };
  }

  // ── The sweep (MdmSyncService.sweep only) ───────────────────────────────

  /** Expire sign-ups nobody finished. Never throws. */
  async pass(now: Date): Promise<number> {
    try {
      const r = await this.prisma.androidSignup.updateMany({ where: { state: 'open', expiresAt: { lt: now } }, data: { state: 'expired' } });
      return r.count;
    } catch (e) { this.logger.warn(`pass: ${(e as Error).name}`); return 0; }
  }
}

function testResult(e: unknown): AndroidTestResult {
  if (!(e instanceof AmapiError)) return 'unreachable';
  switch (e.code) {
    case 'bad_key': return 'bad_key';
    case 'permission_denied': case 'not_found': return 'permission_denied';
    case 'quota': return 'quota';
    case 'bad_response': case 'conflict': return 'bad_response';
    default: return 'unreachable';
  }
}

/** A Google failure as an HTTP error with a code, never Google's text. */
function googleError(e: unknown) {
  const code = e instanceof AmapiError ? e.code : 'unreachable';
  if (code === 'not_ready') return new ServiceUnavailableException({ code: 'ANDROID_NOT_READY', message: 'This server cannot call Google (under NODE_ENV=test only the stand-in is allowed).' });
  if (code === 'bad_key') return new ConflictException({ code: 'ANDROID_KEY_REFUSED', message: ANDROID_TEST_REASON.bad_key });
  if (code === 'permission_denied' || code === 'not_found') return new ConflictException({ code: 'ANDROID_PERMISSION_DENIED', message: ANDROID_TEST_REASON.permission_denied });
  if (code === 'quota') return new ConflictException({ code: 'ANDROID_QUOTA', message: ANDROID_TEST_REASON.quota });
  if (code === 'bad_response' || code === 'conflict') return new ServiceUnavailableException({ code: 'ANDROID_BAD_RESPONSE', message: ANDROID_TEST_REASON.bad_response });
  return new ServiceUnavailableException({ code: 'ANDROID_UNREACHABLE', message: ANDROID_TEST_REASON.unreachable });
}
