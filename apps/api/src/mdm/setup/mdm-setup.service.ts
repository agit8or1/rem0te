import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MdmPlatformSetup, Prisma } from '@prisma/client';
import { createPrivateKey, type KeyObject, type X509Certificate } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { ActorContext } from '../../rbac/access-control.service';
import { openSecret, sealSecret } from '../../common/secret-box';
import { activePause } from '../../containment/pause';
import { SecurityAlertService } from '../../security-controls/alerts.service';
import { ControlsStore } from '../../security-controls/controls.store';
import {
  attr, buildPushCertRequest, certFacts, checkDeviceCa, checkProfileSigner, checkPushCertificate, checkServiceAccountKey, checkVendor, nameText, readCertificate, readCertificates, readCsr, readPrivateKey,
  generatePushKey,
} from './pki';
import {
  ANDROID_CHECKLIST, APPLE_ACCOUNT_RE, APPLE_CHECKLIST, REMINDER_DAYS, SIGNING_ROUTES, capabilities, daysLeft, dueReminder, platformState, topicDecision,
} from './setup-model';

/** The one row (decision 23: one push certificate per install). */
const ID = 'platform';
const MAX_PEM = 16_384;
const pemText = z.string().min(1).max(MAX_PEM);

/**
 * Settings → Mobile devices (0.83 Beacon, docs/own-mdm.md M1, §92). The only
 * writer of MdmPlatformSetup, and the only user of the four purposes
 * rem0te-apns-push-key-v1, rem0te-mdm-vendor-key-v1, rem0te-apns-push-cert-v1
 * and rem0te-amapi-sa-key-v1. Nothing here calls Apple or Google.
 *
 * Every write is made by a Platform Admin (the controller's class guard),
 * after assertFresh naming mdm.setup (except deleting, which never asks),
 * audited with no secret in meta (logOrFail before a credential changes),
 * and conditional on the revision read, so two people cannot both win.
 *
 * Views carry no sealed value, no private key and no certificate body: only
 * public facts. The CSR is returned by its own download, and the signed
 * request only to the Platform Admin who asked for it, once per request.
 */
@Injectable()
export class MdmSetupService {
  private readonly logger = new Logger('MdmSetup');
  private readonly encKey: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly alerts: SecurityAlertService,
    private readonly controls: ControlsStore,
    config: ConfigService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY');
  }

  private async row(): Promise<MdmPlatformSetup> {
    const r = await this.prisma.mdmPlatformSetup.findUnique({ where: { id: ID } });
    if (!r) throw new ServiceUnavailableException({ code: 'MDM_SETUP_MISSING', message: 'The mobile-device setup row is missing: run the database migrations.' });
    return r;
  }

  /** The one way a person's change is written: conditional on the revision read. */
  private async write(r: MdmPlatformSetup, data: Prisma.MdmPlatformSetupUpdateManyMutationInput) {
    const w = await this.prisma.mdmPlatformSetup.updateMany({ where: { id: ID, revision: r.revision }, data: { ...data, revision: { increment: 1 } } });
    if (w.count !== 1) throw new ConflictException({ code: 'MDM_SETUP_CHANGED', message: 'Mobile-device setup changed while you were saving (someone else saved first). Reload and try again.' });
  }

  private auditBase(a: ActorContext) {
    return { actorId: a.userId, actorIp: a.ip, resource: 'mdm_setup', resourceId: ID } as const;
  }

  // ── The view ────────────────────────────────────────────────────────────

  async view(now = new Date()) {
    const r = await this.row();
    // 0.84: what the own MDM server has seen (AppleDevice is the Apple services' table; read only here).
    const [enrolled, proven, lastSeen] = await Promise.all([
      this.prisma.appleDevice.count({ where: { state: 'enrolled' } }),
      // "Proven" only when APNs answered 200 AND that device connected afterwards.
      this.prisma.appleDevice.findFirst({ where: { lastPushOkAt: { not: null }, state: 'enrolled' }, select: { lastPushOkAt: true, lastSeenAt: true }, orderBy: { lastPushOkAt: 'desc' } }),
      this.prisma.appleDevice.findFirst({ where: { state: 'enrolled' }, select: { lastSeenAt: true }, orderBy: { lastSeenAt: { sort: 'desc', nulls: 'last' } } }),
    ]);
    const apple = { enrolled, pushProven: !!proven?.lastPushOkAt && !!proven.lastSeenAt && proven.lastSeenAt.getTime() >= proven.lastPushOkAt.getTime(), lastCheckInAt: lastSeen?.lastSeenAt ?? null };
    const vendorCert = r.vendorCertPem ? readCertificate(r.vendorCertPem) : null;
    const vf = vendorCert ? certFacts(vendorCert) : null;
    const vendorRoot = r.vendorChainPem ? readCertificates(r.vendorChainPem)?.[1] ?? null : null;
    const rf = vendorRoot ? certFacts(vendorRoot) : null;
    const caps = capabilities({
      pushKey: !!r.pushKeyEnc,
      vendor: r.vendorNotAfter ? { notAfter: r.vendorNotAfter } : null,
      signingRoute: (r.signingRoute as never) ?? null,
      pushCert: r.pushCertNotAfter ? { notAfter: r.pushCertNotAfter } : null,
      appleAccount: r.appleAccount,
      androidKey: !!r.androidKeyEnc,
      deviceCa: !!r.deviceCaRootPem,
      profileSigner: r.profileSignNotAfter ? { notAfter: r.profileSignNotAfter } : null,
      enrolledDevices: apple.enrolled,
      pushProven: apple.pushProven,
    }, now);
    const paused = !!(await activePause(this.prisma, 'notifications', null));
    return {
      revision: r.revision,
      apple: {
        state: platformState(caps, 'apple'),
        checklist: r.appleChecklist,
        signingRoute: r.signingRoute,
        pushKey: r.pushKeyEnc ? { present: true, createdAt: r.pushKeyCreatedAt, publicKeySha256: r.pushKeySpkiSha256 } : { present: false },
        vendor: r.vendorKeyEnc && vf ? {
          present: true, subject: nameText(vf.subject), issuer: nameText(vf.issuer), notAfter: r.vendorNotAfter, setAt: r.vendorSetAt,
          expired: r.vendorNotAfter!.getTime() <= now.getTime(),
          rootSubject: rf ? nameText(rf.subject) : null, rootSha256: rf?.sha256 ?? null,
        } : { present: false },
        pushCertificate: r.pushCertEnc ? {
          present: true, topic: r.apnsTopic, serial: r.pushCertSerial, sha256: r.pushCertSha256, issuer: r.pushCertIssuer,
          notBefore: r.pushCertNotBefore, notAfter: r.pushCertNotAfter, installedAt: r.pushCertInstalledAt, renewedAt: r.pushCertRenewedAt,
          daysLeft: daysLeft(r.pushCertNotAfter!, now), expired: r.pushCertNotAfter!.getTime() <= now.getTime(),
          /** 0.84: APNs answered 200 and that device connected afterwards. Under NODE_ENV=test that answer is the suite's stub. */
          proven: apple.pushProven,
        } : { present: false },
        topic: r.apnsTopic,
        appleAccount: r.appleAccount,
        devicesOnTopic: r.apnsTopic ? await this.prisma.mobileDevice.count({ where: { connector: { externalTenantId: r.apnsTopic } } }) : 0,
        reminders: { days: [...REMINDER_DAYS], lastSent: r.pushRemindedDays, sweep: process.env.MDM_SWEEP !== 'off', heldByPause: paused },
        deviceCa: r.deviceCaRootPem ? {
          present: true, rootSha256: r.deviceCaRootSha256, notAfter: r.deviceCaNotAfter, setAt: r.deviceCaSetAt,
          intermediates: r.deviceCaChainPem ? (readCertificates(r.deviceCaChainPem)?.length ?? 0) : 0,
        } : { present: false },
        profileSigner: r.profileSignKeyEnc ? { present: true, sha256: r.profileSignSha256, notAfter: r.profileSignNotAfter, setAt: r.profileSignSetAt } : { present: false },
        enrollment: { devicesEnrolled: apple.enrolled, pushProven: apple.pushProven, lastCheckInAt: apple.lastCheckInAt },
      },
      android: {
        state: platformState(caps, 'android'),
        checklist: r.androidChecklist,
        serviceAccount: r.androidKeyEnc ? {
          present: true, projectId: r.androidProjectId, clientEmail: r.androidClientEmail, keyIdLast4: r.androidKeyIdLast4, setAt: r.androidKeySetAt,
        } : { present: false },
      },
      capabilities: caps,
      outboundCalls: false,
    };
  }

  // ── The owner's ticks and choices ───────────────────────────────────────

  async setChecklist(a: ActorContext, body: unknown) {
    const p = z.object({ platform: z.enum(['apple', 'android']), items: z.array(z.string().max(40)).max(10) }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Give platform (apple or android) and items.' });
    const allowed: readonly string[] = p.data.platform === 'apple' ? APPLE_CHECKLIST : ANDROID_CHECKLIST;
    const items = allowed.filter((i) => p.data.items.includes(i));
    if (items.length !== new Set(p.data.items).size) throw new BadRequestException({ code: 'UNKNOWN_CHECKLIST_ITEM', message: `Known items: ${allowed.join(', ')}.` });
    const r = await this.row();
    const before = p.data.platform === 'apple' ? r.appleChecklist : r.androidChecklist;
    await this.write(r, p.data.platform === 'apple' ? { appleChecklist: items } : { androidChecklist: items });
    await this.audit.log({ action: 'MDM_SETUP_CHANGED', ...this.auditBase(a), meta: { op: 'checklist', platform: p.data.platform, before, after: items } });
    return this.view();
  }

  async setSigningRoute(a: ActorContext, body: unknown) {
    const p = z.object({ route: z.enum(SIGNING_ROUTES) }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: `route is one of ${SIGNING_ROUTES.join(', ')}.` });
    const r = await this.row();
    await this.write(r, { signingRoute: p.data.route });
    await this.audit.log({ action: 'MDM_SETUP_CHANGED', ...this.auditBase(a), meta: { op: 'signing_route', before: r.signingRoute, after: p.data.route } });
    return this.view();
  }

  // ── Apple: the push key and CSR ─────────────────────────────────────────

  /**
   * A new RSA push key, sealed at once, and its CSR. Refused while a push
   * certificate is installed (renewal reuses the same key, so the topic and
   * every enrolled device are kept), and over an existing key unless
   * `replace` says so (a request already sent to Apple would then be
   * useless).
   */
  async generatePushKey(a: ActorContext, body: unknown) {
    const p = z.object({ replace: z.boolean().optional() }).strict().safeParse(body ?? {});
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'The only option is replace.' });
    const r = await this.row();
    if (r.pushCertEnc) throw new ConflictException({ code: 'APNS_CERT_INSTALLED', message: 'A push certificate is installed. Renew it with the existing request: a new key would need a new certificate.' });
    if (r.pushKeyEnc && !p.data.replace) throw new ConflictException({ code: 'PUSH_KEY_EXISTS', message: 'A push key already exists. Download its request, or replace it on purpose.' });
    const k = generatePushKey();
    const csr = readCsr(k.csrPem);
    if (!csr?.ok || csr.spkiSha256 !== k.spkiSha256) throw new ServiceUnavailableException({ code: 'CSR_SELF_CHECK_FAILED', message: 'The new request did not verify against its key.' });
    const sealed = sealSecret(this.encKey, 'rem0te-apns-push-key-v1', k.keyPem);
    await this.audit.logOrFail({
      action: 'MDM_SETUP_CREDENTIAL_SET', ...this.auditBase(a),
      meta: { credential: 'apns_push_key', op: r.pushKeyEnc ? 'replace' : 'create', publicKeySha256: k.spkiSha256, previousPublicKeySha256: r.pushKeySpkiSha256 },
    });
    await this.write(r, { pushKeyEnc: sealed, pushCsrPem: k.csrPem, pushKeySpkiSha256: k.spkiSha256, pushKeyCreatedAt: new Date() });
    return this.view();
  }

  /** The CSR (public), for the mdmcert.download or another vendor's route. Never the key. */
  async pushCsr() {
    const r = await this.row();
    if (!r.pushCsrPem) throw new NotFoundException({ code: 'NO_PUSH_KEY', message: 'Generate the push request first.' });
    return { filename: 'rem0te-push.csr', csr: r.pushCsrPem, publicKeySha256: r.pushKeySpkiSha256 };
  }

  async deletePushKey(a: ActorContext) {
    const r = await this.row();
    if (!r.pushKeyEnc) throw new NotFoundException({ code: 'NO_PUSH_KEY', message: 'There is no push key.' });
    if (r.pushCertEnc) throw new ConflictException({ code: 'APNS_CERT_INSTALLED', message: 'Delete the push certificate first: it was issued for this key.' });
    await this.audit.logOrFail({ action: 'MDM_SETUP_CREDENTIAL_DELETED', ...this.auditBase(a), meta: { credential: 'apns_push_key', publicKeySha256: r.pushKeySpkiSha256 } });
    await this.write(r, { pushKeyEnc: null, pushCsrPem: null, pushKeySpkiSha256: null, pushKeyCreatedAt: null });
    return this.view();
  }

  // ── Apple: the MDM vendor certificate (decision 22) ─────────────────────

  async setVendor(a: ActorContext, body: unknown) {
    const p = z.object({ certificate: pemText, privateKey: pemText, passphrase: z.string().max(200).optional(), chain: z.string().min(1).max(MAX_PEM * 2) }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Give certificate, privateKey and chain (and passphrase if the key is encrypted).' });
    const now = new Date();
    const v = checkVendor(p.data, now);
    if (!v.ok) throw new BadRequestException({ code: v.code, message: v.message });
    const r = await this.row();
    const sealed = sealSecret(this.encKey, 'rem0te-mdm-vendor-key-v1', v.keyPem);
    await this.audit.logOrFail({
      action: 'MDM_SETUP_CREDENTIAL_SET', ...this.auditBase(a),
      meta: { credential: 'mdm_vendor_key', op: r.vendorKeyEnc ? 'replace' : 'create', subject: nameText(v.facts.subject).slice(0, 200), certSha256: v.facts.sha256, notAfter: v.facts.notAfter.toISOString(), rootSha256: v.rootSha256 },
    });
    await this.write(r, { vendorKeyEnc: sealed, vendorCertPem: v.cert.toString(), vendorChainPem: v.chainPem, vendorNotAfter: v.facts.notAfter, vendorSetAt: now, signingRoute: r.signingRoute ?? 'own_vendor' });
    return { ...(await this.view()), vendorCheck: { rootSha256: v.rootSha256, intermediate: nameText(v.intermediate.subject), root: nameText(v.root.subject) } };
  }

  async deleteVendor(a: ActorContext) {
    const r = await this.row();
    if (!r.vendorKeyEnc) throw new NotFoundException({ code: 'NO_VENDOR', message: 'There is no vendor certificate.' });
    await this.audit.logOrFail({ action: 'MDM_SETUP_CREDENTIAL_DELETED', ...this.auditBase(a), meta: { credential: 'mdm_vendor_key' } });
    await this.write(r, { vendorKeyEnc: null, vendorCertPem: null, vendorChainPem: null, vendorNotAfter: null, vendorSetAt: null });
    return this.view();
  }

  /**
   * The signed PushCertRequest for Apple's push certificates portal, from the sealed push
   * CSR and the sealed vendor key, opened in memory for this one signature.
   * Nothing is stored; the file goes to this Platform Admin only.
   */
  async signPushRequest(a: ActorContext) {
    const r = await this.row();
    if (!r.pushCsrPem) throw new ConflictException({ code: 'NO_PUSH_KEY', message: 'Generate the push request first (step 2).' });
    if (!r.vendorKeyEnc || !r.vendorCertPem || !r.vendorChainPem) throw new ConflictException({ code: 'NO_VENDOR', message: 'Upload your MDM vendor certificate first (step 3).' });
    if (r.vendorNotAfter!.getTime() <= Date.now()) throw new ConflictException({ code: 'VENDOR_CERT_EXPIRED', message: 'The vendor certificate has expired.' });
    const csr = readCsr(r.pushCsrPem);
    if (!csr?.ok) throw new ServiceUnavailableException({ code: 'CSR_SELF_CHECK_FAILED', message: 'The stored request did not verify.' });
    const k = readPrivateKey(openSecret(this.encKey, 'rem0te-mdm-vendor-key-v1', r.vendorKeyEnc));
    if (!k.ok) throw new ServiceUnavailableException({ code: 'VENDOR_KEY_UNREADABLE', message: 'The sealed vendor key could not be opened.' });
    const req = buildPushCertRequest({ csrDer: csr.der, vendorKey: k.key, vendorCertPem: r.vendorCertPem, chainPem: r.vendorChainPem });
    await this.audit.logOrFail({ action: 'MDM_PUSH_REQUEST_SIGNED', ...this.auditBase(a), meta: { publicKeySha256: r.pushKeySpkiSha256, renewal: !!r.pushCertEnc } });
    return { filename: 'rem0te-PushCertificateRequest.txt', request: req.file };
  }

  // ── Apple: the push certificate ─────────────────────────────────────────

  /**
   * Install, renew or (with `replace`) replace the push certificate. In
   * order: the shape; the push key exists; the pure check (one certificate,
   * a push topic, the sealed key's public key, unexpired, already valid);
   * the topic rule (the same topic, unless the replace action names the
   * current one); the Apple Account typed; then the audit, then the
   * conditional write. A renewal clears the reminders.
   */
  async installPushCert(a: ActorContext, body: unknown, replace: boolean) {
    const shape = z.object({
      certificate: pemText,
      appleAccount: z.string().max(254).regex(APPLE_ACCOUNT_RE),
      ...(replace ? { currentTopic: z.string().max(80), acknowledgeReenroll: z.literal(true) } : {}),
    }).strict();
    const p = shape.safeParse(body);
    if (!p.success) {
      throw new BadRequestException({ code: 'INVALID_REQUEST', message: replace
        ? 'Give certificate, appleAccount (the Apple Account it belongs to), currentTopic and acknowledgeReenroll: true.'
        : 'Give certificate and appleAccount (the Apple Account that owns it, as an e-mail address).' });
    }
    const d = p.data as { certificate: string; appleAccount: string; currentTopic?: string };
    const r = await this.row();
    if (!r.pushKeyEnc) throw new ConflictException({ code: 'NO_PUSH_KEY', message: 'Generate the push request first: the certificate must match Rem0te\'s push key.' });
    const key = readPrivateKey(openSecret(this.encKey, 'rem0te-apns-push-key-v1', r.pushKeyEnc));
    if (!key.ok) throw new ServiceUnavailableException({ code: 'PUSH_KEY_UNREADABLE', message: 'The sealed push key could not be opened.' });
    const now = new Date();
    const c = checkPushCertificate(d.certificate, key.key, now);
    if (!c.ok) throw new BadRequestException({ code: c.code, message: c.message });
    const t = topicDecision(r.apnsTopic, c.topic, replace ? { currentTopic: d.currentTopic! } : null);
    if (!t.ok) {
      const devices = r.apnsTopic ? await this.prisma.mobileDevice.count({ where: { connector: { externalTenantId: r.apnsTopic } } }) : 0;
      const message = {
        APNS_TOPIC_CHANGED: `This certificate's topic (${c.topic}) is not the installed one (${r.apnsTopic}). It was made with a different Apple Account: renew with the account that made the first one. Replacing the topic means every enrolled device (${devices} now) must enroll again, and is its own action.`,
        APNS_TOPIC_SAME: 'This certificate has the same topic: upload it as a renewal, not a replacement.',
        APNS_REPLACE_STALE: 'The topic you are replacing is not the installed one. Reload and try again.',
        APNS_NOTHING_TO_REPLACE: 'There is no topic to replace: upload the certificate normally.',
      }[t.code];
      throw new ConflictException({ code: t.code, message, devicesToReenroll: devices });
    }
    const devices = t.op === 'replace' ? await this.prisma.mobileDevice.count({ where: { connector: { externalTenantId: r.apnsTopic! } } }) : 0;
    const sealed = sealSecret(this.encKey, 'rem0te-apns-push-cert-v1', c.pem);
    await this.audit.logOrFail({
      action: 'MDM_PUSH_CERT_INSTALLED', ...this.auditBase(a),
      meta: {
        op: t.op, topic: c.topic, previousTopic: t.op === 'replace' ? r.apnsTopic : undefined, devicesToReenroll: t.op === 'replace' ? devices : undefined,
        serial: c.facts.serial, certSha256: c.facts.sha256, notAfter: c.facts.notAfter.toISOString(), appleIssued: c.appleIssued,
        appleAccountChanged: !!r.appleAccount && r.appleAccount.toLowerCase() !== d.appleAccount.toLowerCase(),
      },
    });
    await this.write(r, {
      pushCertEnc: sealed, pushCertSerial: c.facts.serial, pushCertSha256: c.facts.sha256, pushCertIssuer: nameText(c.facts.issuer).slice(0, 300),
      pushCertNotBefore: c.facts.notBefore, pushCertNotAfter: c.facts.notAfter,
      pushCertInstalledAt: t.op === 'renew' && r.pushCertInstalledAt ? r.pushCertInstalledAt : now,
      pushCertRenewedAt: t.op === 'renew' ? now : null,
      apnsTopic: c.topic, appleAccount: d.appleAccount, pushRemindedDays: null,
    });
    return { ...(await this.view()), installed: { op: t.op, topic: c.topic, notAfter: c.facts.notAfter, appleIssued: c.appleIssued, subject: attr(c.facts.subject, 'CN') } };
  }

  /** Deleting the certificate never asks, and is audited. The topic is kept, so the next certificate must match it. */
  async deletePushCert(a: ActorContext) {
    const r = await this.row();
    if (!r.pushCertEnc) throw new NotFoundException({ code: 'NO_PUSH_CERT', message: 'There is no push certificate.' });
    const devices = await this.prisma.mobileDevice.count({ where: { connector: { externalTenantId: r.apnsTopic! } } });
    await this.audit.logOrFail({ action: 'MDM_PUSH_CERT_DELETED', ...this.auditBase(a), meta: { topic: r.apnsTopic, serial: r.pushCertSerial, devicesOrphaned: devices } });
    await this.write(r, {
      pushCertEnc: null, pushCertSerial: null, pushCertSha256: null, pushCertIssuer: null, pushCertNotBefore: null, pushCertNotAfter: null,
      pushCertInstalledAt: null, pushCertRenewedAt: null, pushRemindedDays: null,
    });
    return this.view();
  }

  // ── Android: the service-account key ────────────────────────────────────

  async setAndroidKey(a: ActorContext, body: unknown) {
    const p = z.object({ keyFile: z.string().min(1).max(16_384) }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Give keyFile: the service-account key file\'s JSON text.' });
    const k = checkServiceAccountKey(p.data.keyFile);
    if (!k.ok) throw new BadRequestException({ code: k.code, field: k.field, message: k.message });
    const r = await this.row();
    const sealed = sealSecret(this.encKey, 'rem0te-amapi-sa-key-v1', k.sealedJson);
    await this.audit.logOrFail({
      action: 'MDM_SETUP_CREDENTIAL_SET', ...this.auditBase(a),
      meta: { credential: 'amapi_service_account', op: r.androidKeyEnc ? 'replace' : 'create', projectId: k.projectId, clientEmail: k.clientEmail, keyIdLast4: k.keyIdLast4 },
    });
    await this.write(r, { androidKeyEnc: sealed, androidProjectId: k.projectId, androidClientEmail: k.clientEmail, androidKeyIdLast4: k.keyIdLast4, androidKeySetAt: new Date() });
    return this.view();
  }

  async deleteAndroidKey(a: ActorContext) {
    const r = await this.row();
    if (!r.androidKeyEnc) throw new NotFoundException({ code: 'NO_ANDROID_KEY', message: 'There is no service-account key.' });
    await this.audit.logOrFail({ action: 'MDM_SETUP_CREDENTIAL_DELETED', ...this.auditBase(a), meta: { credential: 'amapi_service_account', projectId: r.androidProjectId, keyIdLast4: r.androidKeyIdLast4 } });
    await this.write(r, { androidKeyEnc: null, androidProjectId: null, androidClientEmail: null, androidKeyIdLast4: null, androidKeySetAt: null });
    return this.view();
  }

  // ── Apple step 6 (0.84, M2): the device CA and the profile signer ───────

  /**
   * The device CA's public root and intermediates, from the CA host's
   * `rem0te-mdm-ca-setup.sh` output. Only certificates: the CA's key stays
   * with the `rem0te-mdm-ca` user and never reaches the portal (§93).
   * Replacing it means devices whose certificates chain only to the old CA
   * stop being accepted, so the view names how many are enrolled.
   */
  async setDeviceCa(a: ActorContext, body: unknown) {
    const p = z.object({ root: pemText, intermediates: z.string().max(MAX_PEM * 3).optional() }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Give root (root_ca.crt) and intermediates (intermediate_ca.crt).' });
    const now = new Date();
    const c = checkDeviceCa(p.data, now);
    if (!c.ok) throw new BadRequestException({ code: c.code, message: c.message });
    const r = await this.row();
    await this.audit.logOrFail({
      action: 'MDM_SETUP_CREDENTIAL_SET', ...this.auditBase(a),
      meta: { credential: 'mdm_device_ca', op: r.deviceCaRootPem ? 'replace' : 'create', rootSha256: c.rootFacts.sha256, previousRootSha256: r.deviceCaRootSha256, intermediates: c.intermediates.length, notAfter: c.notAfter.toISOString() },
    });
    await this.write(r, { deviceCaRootPem: c.rootPem, deviceCaChainPem: c.chainPem, deviceCaRootSha256: c.rootFacts.sha256, deviceCaNotAfter: c.notAfter, deviceCaSetAt: now });
    return this.view();
  }

  async deleteDeviceCa(a: ActorContext) {
    const r = await this.row();
    if (!r.deviceCaRootPem) throw new NotFoundException({ code: 'NO_DEVICE_CA', message: 'There is no device CA.' });
    await this.audit.logOrFail({ action: 'MDM_SETUP_CREDENTIAL_DELETED', ...this.auditBase(a), meta: { credential: 'mdm_device_ca', rootSha256: r.deviceCaRootSha256 } });
    await this.write(r, { deviceCaRootPem: null, deviceCaChainPem: null, deviceCaRootSha256: null, deviceCaNotAfter: null, deviceCaSetAt: null });
    return this.view();
  }

  /** The profile-signing identity: the key sealed (rem0te-mdm-profile-sign-v1) before anything is written. */
  async setProfileSigner(a: ActorContext, body: unknown) {
    const p = z.object({ certificate: pemText, privateKey: pemText, passphrase: z.string().max(200).optional(), chain: z.string().max(MAX_PEM * 3).optional() }).strict().safeParse(body);
    if (!p.success) throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'Give certificate and privateKey (and chain, and passphrase if the key is encrypted).' });
    const now = new Date();
    const s = checkProfileSigner(p.data, now);
    if (!s.ok) throw new BadRequestException({ code: s.code, message: s.message });
    const r = await this.row();
    const sealed = sealSecret(this.encKey, 'rem0te-mdm-profile-sign-v1', s.keyPem);
    await this.audit.logOrFail({
      action: 'MDM_SETUP_CREDENTIAL_SET', ...this.auditBase(a),
      meta: { credential: 'mdm_profile_signer', op: r.profileSignKeyEnc ? 'replace' : 'create', subject: nameText(s.facts.subject).slice(0, 200), certSha256: s.facts.sha256, notAfter: s.facts.notAfter.toISOString() },
    });
    await this.write(r, { profileSignKeyEnc: sealed, profileSignCertPem: s.cert.toString(), profileSignChainPem: s.chainPem, profileSignSha256: s.facts.sha256, profileSignNotAfter: s.facts.notAfter, profileSignSetAt: now });
    return this.view();
  }

  async deleteProfileSigner(a: ActorContext) {
    const r = await this.row();
    if (!r.profileSignKeyEnc) throw new NotFoundException({ code: 'NO_PROFILE_SIGNER', message: 'There is no profile-signing certificate.' });
    await this.audit.logOrFail({ action: 'MDM_SETUP_CREDENTIAL_DELETED', ...this.auditBase(a), meta: { credential: 'mdm_profile_signer', certSha256: r.profileSignSha256 } });
    await this.write(r, { profileSignKeyEnc: null, profileSignCertPem: null, profileSignChainPem: null, profileSignSha256: null, profileSignNotAfter: null, profileSignSetAt: null });
    return this.view();
  }

  // ── Opened in memory for M2's two callers (§93) ─────────────────────────

  /** The device CA's public certificates, for verifying Mdm-Signature. Public data; null when not set. */
  async deviceTrust(): Promise<{ roots: X509Certificate[]; intermediates: X509Certificate[] } | null> {
    const r = await this.prisma.mdmPlatformSetup.findUnique({ where: { id: ID }, select: { deviceCaRootPem: true, deviceCaChainPem: true } });
    if (!r?.deviceCaRootPem) return null;
    const root = readCertificate(r.deviceCaRootPem);
    const mids = r.deviceCaChainPem ? readCertificates(r.deviceCaChainPem) : [];
    return root && mids ? { roots: [root], intermediates: mids } : null;
  }

  /**
   * The push key and certificate, opened from secret-box in memory for one
   * APNs session. Only AppleMdmService.pushPass calls this; nothing returned
   * here is stored, logged or sent anywhere but into safe-h2's TLS context.
   */
  async openPushIdentity(now = new Date()): Promise<{ key: KeyObject; certPem: string; topic: string } | null> {
    const r = await this.row();
    if (!r.pushKeyEnc || !r.pushCertEnc || !r.apnsTopic || !r.pushCertNotAfter || r.pushCertNotAfter.getTime() <= now.getTime()) return null;
    const k = readPrivateKey(openSecret(this.encKey, 'rem0te-apns-push-key-v1', r.pushKeyEnc));
    if (!k.ok) return null;
    return { key: k.key, certPem: openSecret(this.encKey, 'rem0te-apns-push-cert-v1', r.pushCertEnc), topic: r.apnsTopic };
  }

  /** The profile-signing identity, opened in memory for one profile. Only AppleEnrollmentService.claim calls this. */
  async openProfileSigner(now = new Date()): Promise<{ cert: X509Certificate; key: KeyObject; chain: X509Certificate[] } | null> {
    const r = await this.row();
    if (!r.profileSignKeyEnc || !r.profileSignCertPem || !r.profileSignNotAfter || r.profileSignNotAfter.getTime() <= now.getTime()) return null;
    const cert = readCertificate(r.profileSignCertPem);
    const chain = r.profileSignChainPem ? readCertificates(r.profileSignChainPem) : [];
    if (!cert || !chain) return null;
    let key: KeyObject;
    try { key = createPrivateKey(openSecret(this.encKey, 'rem0te-mdm-profile-sign-v1', r.profileSignKeyEnc)); } catch { return null; }
    return { cert, key, chain };
  }

  /** What an enrollment link needs before it can make a profile: public facts only. */
  async enrollmentReadiness(now = new Date()): Promise<{ ready: true; topic: string } | { ready: false; code: string; message: string }> {
    const r = await this.row();
    if (!r.pushCertEnc || !r.apnsTopic || !r.pushCertNotAfter) return { ready: false, code: 'APNS_CERT_MISSING', message: 'Install the Apple push certificate first (step 5).' };
    if (r.pushCertNotAfter.getTime() <= now.getTime()) return { ready: false, code: 'APNS_CERT_EXPIRED', message: 'The Apple push certificate has expired: renew it with the same Apple Account.' };
    if (!r.deviceCaRootPem) return { ready: false, code: 'NO_DEVICE_CA', message: 'Upload the device CA\'s certificates first (step 6).' };
    if (!r.profileSignKeyEnc || !r.profileSignNotAfter || r.profileSignNotAfter.getTime() <= now.getTime()) return { ready: false, code: 'NO_PROFILE_SIGNER', message: 'Upload a valid profile-signing certificate first (step 6).' };
    return { ready: true, topic: r.apnsTopic };
  }

  // ── Renewal reminders ───────────────────────────────────────────────────

  /**
   * One pass, run by the MDM sweep (MDM_SWEEP=off stops it). At 30, 14 and
   * 3 days before the push certificate expires, and once when it has
   * expired, raise a security alert (SecurityAlertService: recorded,
   * audited, delivered to the platform's alert destinations unless
   * suppressed). A global `notifications` pause holds it: nothing is claimed,
   * so it is raised when the pause lifts. Each reminder is claimed with a
   * conditional write on the certificate's serial before it is raised, so
   * two API processes never raise the same one. Never throws.
   */
  async reminderPass(now = new Date()): Promise<number | null> {
    try {
      const r = await this.prisma.mdmPlatformSetup.findUnique({ where: { id: ID } });
      if (!r?.pushCertEnc || !r.pushCertNotAfter) return null;
      const due = dueReminder(r.pushCertNotAfter, r.pushRemindedDays, now);
      if (due === null) return null;
      if (await activePause(this.prisma, 'notifications', null)) return null;
      const claimed = await this.prisma.mdmPlatformSetup.updateMany({
        where: { id: ID, pushCertSerial: r.pushCertSerial, OR: [{ pushRemindedDays: null }, { pushRemindedDays: { gt: due } }] },
        data: { pushRemindedDays: due },
      });
      if (claimed.count !== 1) return null;
      const controls = await this.controls.platform();
      await this.alerts.raise({
        kind: due === 0 ? 'mdm_push_cert_expired' : 'mdm_push_cert_expiring', identity: r.apnsTopic,
        details: { topic: r.apnsTopic, notAfter: r.pushCertNotAfter.toISOString(), daysLeft: daysLeft(r.pushCertNotAfter, now), reminder: due, renewWithSameAccount: true },
        destinations: controls.alertDestinations,
      });
      return due;
    } catch (e) {
      this.logger.warn(`push certificate reminder: ${(e as Error).name}`);
      return null;
    }
  }
}
