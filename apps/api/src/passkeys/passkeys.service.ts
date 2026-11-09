import { createHash } from 'node:crypto';
import {
  BadRequestException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { PublicUrlService } from '../platform/public-url.service';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PASSKEYS = 10;
type Purpose = 'REGISTER' | 'LOGIN' | 'STEP_UP';

/**
 * Passkeys (WebAuthn), for sign-in and for step-up.
 *
 *   - User verification is required on every ceremony, so a passkey sign-in
 *     is multi-factor on its own (possession + biometric/PIN) and skips TOTP.
 *   - Challenges are server-stored and single-use: a ceremony is accepted
 *     only by the request that deletes its challenge row.
 *   - The signature counter is checked for regression by the library; a
 *     cloned authenticator that replays an old counter is refused.
 *   - Adding or removing a passkey needs a step-up (passkey.manage), so a
 *     borrowed session cannot plant a permanent way back in.
 *
 * Relying party: WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN, defaulting to the host and
 * origin of the server's public address (Settings → General, else FRONTEND_URL)
 * — the browser-visible address of the web app.
 */
@Injectable()
export class PasskeysService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PasskeysService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly urls: PublicUrlService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      this.prisma.webAuthnChallenge.deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch((e) => this.logger.error('WebAuthn challenge cleanup failed', e));
    }, 10 * 60_000);
    this.timer.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  rp() {
    const front = new URL(this.urls.web());
    return {
      rpID: this.config.get<string>('WEBAUTHN_RP_ID') || front.hostname,
      origin: this.config.get<string>('WEBAUTHN_ORIGIN') || front.origin,
    };
  }

  private async saveChallenge(challenge: string, purpose: Purpose, userId: string | null) {
    await this.prisma.webAuthnChallenge.create({ data: { challenge, purpose, userId, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) } });
  }

  /** The challenge a response answers, consumed. Throws unless it was ours, unexpired and unused. */
  private async consume(clientDataJSON: string, purpose: Purpose, userId: string | null): Promise<string> {
    let challenge: string;
    try {
      challenge = String(JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')).challenge ?? '');
    } catch { throw new BadRequestException('Malformed passkey response'); }
    if (!challenge || challenge.length > 200) throw new BadRequestException('Malformed passkey response');
    const r = await this.prisma.webAuthnChallenge.deleteMany({
      where: { challenge, purpose, expiresAt: { gt: new Date() }, ...(userId ? { userId } : { userId: null }) },
    });
    if (r.count !== 1) throw new UnauthorizedException('This passkey request has expired. Try again.');
    return challenge;
  }

  private async credentials(userId: string) {
    return this.prisma.userMfaMethod.findMany({
      where: { userId, type: 'WEBAUTHN', isActive: true },
      select: { id: true, credentialId: true, transports: true, name: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Registration ──────────────────────────────────────────────────────

  async registrationOptions(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, firstName: true, lastName: true } });
    if (!user) throw new NotFoundException('User not found');
    const existing = await this.credentials(userId);
    if (existing.length >= MAX_PASSKEYS) throw new BadRequestException(`An account can hold at most ${MAX_PASSKEYS} passkeys`);
    const { rpID } = this.rp();
    const options = await generateRegistrationOptions({
      rpName: 'Rem0te', rpID, userName: user.email,
      userDisplayName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      userID: new Uint8Array(Buffer.from(user.id, 'utf8')),
      attestationType: 'none',
      excludeCredentials: existing.filter((c) => c.credentialId).map((c) => ({ id: c.credentialId!, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await this.saveChallenge(options.challenge, 'REGISTER', userId);
    return options;
  }

  async register(userId: string, response: RegistrationResponseJSON, name: string | undefined, ip?: string) {
    const expectedChallenge = await this.consume(response?.response?.clientDataJSON ?? '', 'REGISTER', userId);
    const { rpID, origin } = this.rp();
    let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    } catch (e) {
      throw new BadRequestException(`Passkey could not be verified: ${(e as Error).message.slice(0, 200)}`);
    }
    if (!v.verified || !v.registrationInfo) throw new BadRequestException('Passkey could not be verified');
    const cred = v.registrationInfo.credential;
    if (await this.prisma.userMfaMethod.findFirst({ where: { type: 'WEBAUTHN', credentialId: cred.id } })) {
      throw new BadRequestException('This passkey is already registered');
    }
    const row = await this.prisma.userMfaMethod.create({
      data: {
        userId, type: 'WEBAUTHN', isActive: true, credentialId: cred.id, publicKey: Buffer.from(cred.publicKey),
        signCount: cred.counter, transports: (cred.transports ?? []).slice(0, 8), name: (name?.trim() || 'Passkey').slice(0, 60),
      },
    });
    await this.audit.log({ actorId: userId, actorIp: ip, action: 'PASSKEY_REGISTERED', resource: 'user', resourceId: userId, meta: { passkeyId: row.id, name: row.name } });
    return { id: row.id, name: row.name, createdAt: row.createdAt };
  }

  /**
   * The person's own passkeys. Each carries an `approvalExport`: the public
   * half and a fingerprint, which an operator adds to the approval signer's
   * roster (v0.26) only after this person reads the fingerprint back to them.
   * Public keys only — nothing here authenticates as anyone.
   */
  async list(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true, email: true } });
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || userId;
    const rows = await this.prisma.userMfaMethod.findMany({
      where: { userId, type: 'WEBAUTHN', isActive: true },
      select: { id: true, credentialId: true, publicKey: true, name: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((c) => {
      const pk = c.publicKey ? Buffer.from(c.publicKey).toString('base64url') : null;
      const fp = c.credentialId && pk ? createHash('sha256').update(`${c.credentialId}:${pk}`).digest('hex').slice(0, 16).replace(/(.{4})(?!$)/g, '$1-') : null;
      return {
        id: c.id, name: c.name, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt,
        approvalFingerprint: fp,
        approvalExport: fp ? JSON.stringify({ userId, name, credentialId: c.credentialId, publicKey: pk }) : null,
      };
    });
  }

  async remove(userId: string, id: string, ip?: string) {
    const r = await this.prisma.userMfaMethod.deleteMany({ where: { id, userId, type: 'WEBAUTHN' } });
    if (!r.count) throw new NotFoundException('Passkey not found');
    await this.audit.log({ actorId: userId, actorIp: ip, action: 'PASSKEY_REMOVED', resource: 'user', resourceId: userId, meta: { passkeyId: id } });
    return { deleted: true };
  }

  // ── Assertion (sign-in and step-up) ────────────────────────────────────

  async loginOptions() {
    const { rpID } = this.rp();
    // No allowCredentials: discoverable credentials, so the browser offers
    // the user's passkeys without the server revealing whether an email exists.
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    await this.saveChallenge(options.challenge, 'LOGIN', null);
    return options;
  }

  async stepUpOptions(userId: string) {
    const creds = await this.credentials(userId);
    if (!creds.length) throw new BadRequestException('You have no passkeys');
    const { rpID } = this.rp();
    const options = await generateAuthenticationOptions({
      rpID, userVerification: 'required',
      allowCredentials: creds.filter((c) => c.credentialId).map((c) => ({ id: c.credentialId!, transports: c.transports as AuthenticatorTransport[] })),
    });
    await this.saveChallenge(options.challenge, 'STEP_UP', userId);
    return options;
  }

  /** Verify an assertion; returns the account it proves. */
  private async assert(response: AuthenticationResponseJSON, purpose: 'LOGIN' | 'STEP_UP', userId: string | null, ip?: string) {
    const expectedChallenge = await this.consume(response?.response?.clientDataJSON ?? '', purpose, userId);
    const method = typeof response?.id === 'string'
      ? await this.prisma.userMfaMethod.findFirst({
          where: { type: 'WEBAUTHN', isActive: true, credentialId: response.id, ...(userId ? { userId } : {}) },
          select: { id: true, userId: true, credentialId: true, publicKey: true, signCount: true, transports: true },
        })
      : null;
    if (!method?.publicKey || !method.credentialId) {
      await this.audit.log({ actorId: userId ?? undefined, actorIp: ip, action: purpose === 'LOGIN' ? 'LOGIN_FAILURE' : 'STEP_UP_FAILED', meta: { reason: 'passkey_unknown' } });
      throw new UnauthorizedException('That passkey is not registered here');
    }
    // The authenticator's user handle, when sent, must be the account's.
    const handle = response.response.userHandle;
    if (handle && Buffer.from(handle, 'base64url').toString('utf8') !== method.userId) {
      throw new UnauthorizedException('That passkey is not registered here');
    }
    const { rpID, origin } = this.rp();
    let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      v = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: method.credentialId, publicKey: new Uint8Array(method.publicKey), counter: method.signCount ?? 0, transports: method.transports as AuthenticatorTransport[] },
      });
    } catch (e) {
      await this.audit.log({ actorId: method.userId, actorIp: ip, action: purpose === 'LOGIN' ? 'LOGIN_FAILURE' : 'STEP_UP_FAILED', meta: { reason: 'passkey_invalid', detail: (e as Error).message.slice(0, 120) } });
      throw new UnauthorizedException('The passkey could not be verified');
    }
    if (!v.verified) throw new UnauthorizedException('The passkey could not be verified');
    await this.prisma.userMfaMethod.update({ where: { id: method.id }, data: { signCount: v.authenticationInfo.newCounter, lastUsedAt: new Date() } });
    return method.userId;
  }

  async login(response: AuthenticationResponseJSON, ip: string, userAgent: string) {
    const userId = await this.assert(response, 'LOGIN', null, ip);
    const result = await this.auth.signInVerifiedUser(userId, ip, userAgent, 'passkey', true);
    await this.audit.log({ actorId: userId, actorIp: ip, actorAgent: userAgent, action: 'PASSKEY_LOGIN', resource: 'user', resourceId: userId });
    return result;
  }

  async stepUp(userId: string, response: AuthenticationResponseJSON, ip?: string) {
    await this.assert(response, 'STEP_UP', userId, ip);
    await this.audit.log({ actorId: userId, actorIp: ip, action: 'STEP_UP_VERIFIED', meta: { method: 'passkey' } });
    return 'passkey';
  }
}
