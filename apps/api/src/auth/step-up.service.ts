import { ForbiddenException, Global, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Step-up authentication: a recent re-authentication, on top of a valid
 * session, for the actions where a stolen or unattended session would do the
 * most harm.
 *
 * Vocabulary (PlatformSettings.stepUpActions holds the enabled subset):
 *   credential.reveal    revealing a computer's stored RustDesk password
 *   permissions.change   changing a business user's capabilities or role
 *   technicians.manage   technician assignments, groups, platform permissions
 *   sso.configure        OIDC provider configuration and account linking
 *   passkey.manage       adding or removing a passkey
 *
 * The proof is a short-lived HMAC token in an httpOnly, SameSite=strict cookie,
 * bound to the user and to the session it was earned in (the access token's
 * `iat`), minted by POST /auth/step-up after a password, TOTP code or passkey
 * check. It is not a session: it grants nothing alone, and every route still
 * runs its normal authorization first.
 *
 * Refused step-ups answer 403 with code STEP_UP_REQUIRED so the UI can prompt
 * and retry instead of showing a dead end.
 */
export const STEP_UP_ACTIONS = [
  'credential.reveal',
  'permissions.change',
  'technicians.manage',
  'sso.configure',
  'passkey.manage',
] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export const STEP_UP_COOKIE = 'step_up';
export const STEP_UP_TTL_MS = 10 * 60_000;

@Injectable()
export class StepUpService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private key(): Buffer {
    const secret = this.config.get<string>('JWT_SECRET') ?? '';
    return createHmac('sha256', secret).update('rem0te-step-up-v1').digest();
  }

  private sign(body: string): string {
    return createHmac('sha256', this.key()).update(body).digest('base64url');
  }

  /** Mint and set the step-up cookie for this user and session. */
  issue(res: Response, userId: string, sessionIat: number | undefined, method: string): Date {
    const exp = Date.now() + STEP_UP_TTL_MS;
    const body = Buffer.from(JSON.stringify({ sub: userId, sid: sessionIat ?? 0, exp, m: method })).toString('base64url');
    const token = `${body}.${this.sign(body)}`;
    res.cookie(STEP_UP_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
      sameSite: 'strict',
      maxAge: STEP_UP_TTL_MS,
      path: '/',
    });
    return new Date(exp);
  }

  clear(res: Response) {
    res.clearCookie(STEP_UP_COOKIE, { path: '/' });
  }

  /** Validity of the presented step-up for this user/session, or null. */
  read(req: Request, userId: string, sessionIat: number | undefined): { expiresAt: Date; method: string } | null {
    const raw = (req.cookies as Record<string, string> | undefined)?.[STEP_UP_COOKIE]
      ?? (req.headers?.['x-rem0te-step-up'] as string | undefined);
    if (!raw || typeof raw !== 'string') return null;
    const [body, mac] = raw.split('.');
    if (!body || !mac) return null;
    const want = Buffer.from(this.sign(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sub: string; sid: number; exp: number; m: string };
      if (p.sub !== userId) return null;
      if ((p.sid ?? 0) !== (sessionIat ?? 0)) return null;
      if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
      return { expiresAt: new Date(p.exp), method: p.m };
    } catch {
      return null;
    }
  }

  async enabledActions(): Promise<string[]> {
    const s = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { stepUpActions: true } });
    // No row yet: the schema defaults, i.e. everything on.
    return s?.stepUpActions ?? [...STEP_UP_ACTIONS];
  }

  /**
   * Throw STEP_UP_REQUIRED unless `action` is not configured for step-up or
   * the request carries a valid one. `req.user` must already be the
   * authenticated JWT payload.
   */
  async assert(req: Request, action: StepUpAction): Promise<void> {
    const enabled = await this.enabledActions();
    if (!enabled.includes(action)) return;
    const user = req.user as { sub?: string; iat?: number } | undefined;
    if (!user?.sub) throw new ForbiddenException('Not authenticated');
    if (this.read(req, user.sub, user.iat)) return;
    throw new ForbiddenException({
      message: 'Confirm it is you to continue: re-enter your password, an authenticator code, or use a passkey.',
      code: 'STEP_UP_REQUIRED',
      action,
    });
  }
}

@Global()
@Module({
  providers: [StepUpService],
  exports: [StepUpService],
})
export class StepUpModule {}
