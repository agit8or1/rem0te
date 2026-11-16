import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { issueAt, revocationInstant } from './session-revocation';
import { AuditService } from '../audit/audit.service';
import { MfaService } from '../mfa/mfa.service';
import type { JwtPayload } from './strategies/jwt.strategy';
import type { LoginDto, RegisterDto } from './dto/login.dto';
import { isSsoMode, localSignInRefused, type SsoMode } from '../sso/identity-policy';

/**
 * Hooks the SSO module registers at start (0.59), so AuthService needs no
 * import of it: what to do when a break-glass account signs in, and how to
 * end an SSO session at its provider on sign-out.
 */
export interface AuthHooks {
  /** After the BREAK_GLASS_LOGIN audit entry is written: raise the alert, email Platform Admins. */
  breakGlassSignIn?(userId: string, method: string, ip: string): Promise<void>;
  /** The provider's end-session URL for the SSO session minted at `sessionIat`, or null. */
  endSessionUrl?(userId: string, sessionIat: number | undefined): Promise<string | null>;
}

@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);

  /**
   * The pre-MFA token is signed with a key derived from JWT_SECRET rather than
   * with JWT_SECRET itself.
   *
   * It used to be signed with the session key, and `JwtStrategy` accepted it,
   * so anyone holding a password could skip the second factor entirely: the
   * partial token is handed to the browser after the password check and worked
   * as a bearer credential on every route. The strategy now refuses tokens
   * carrying `partial`, and a separate key means the two can never be
   * interchangeable even if that check is ever lost again. Derived rather than
   * configured so an existing deployment needs no new environment variable.
   */
  /**
   * Failed password attempts per account, in process.
   *
   * `PlatformSecurityConfig.maxLoginAttempts` and `.lockoutMinutes` have been
   * configurable — and shown in the Security page — since before there was any
   * code that read them, so an operator could set a lockout policy that did
   * nothing at all. The per-IP throttle is the other half and lives on the
   * route; this half is per-account, so distributing an attack across addresses
   * does not buy the attacker anything.
   *
   * 0.59: in the database (LoginLockout, 0080), one row per account. It was
   * a Map in this process, so a restart forgot every lockout and a second
   * process (the integration worker, a second API) kept its own count.
   * `lockedUntil` doubles as the time of the last failure while the account
   * is not locked, as the Map's did. Rows are pruned once they say nothing.
   */
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private hooks: AuthHooks = {};

  /** Called once by the SSO module at start. */
  setHooks(h: AuthHooks) { this.hooks = { ...this.hooks, ...h }; }

  onModuleInit() {
    this.pruneTimer = setInterval(() => { void this.pruneLockouts(); }, 60 * 60_000);
    this.pruneTimer.unref?.();
  }
  onModuleDestroy() { if (this.pruneTimer) clearInterval(this.pruneTimer); }

  /** A row whose lock has passed and that has not moved for a day has nothing left to say. */
  async pruneLockouts(now = Date.now()): Promise<number> {
    const r = await this.prisma.loginLockout.deleteMany({
      where: { updatedAt: { lt: new Date(now - 24 * 60 * 60_000) }, lockedUntil: { lt: new Date(now) } },
    }).catch((e: Error) => { this.logger.warn(`lockout prune failed: ${e.message}`); return { count: 0 }; });
    return r.count;
  }

  private async lockoutPolicy(): Promise<{ max: number; minutes: number }> {
    const cfg = await this.prisma.platformSecurityConfig.findFirst({
      select: { maxLoginAttempts: true, lockoutMinutes: true },
    });
    return {
      max: cfg?.maxLoginAttempts ?? 5,
      minutes: cfg?.lockoutMinutes ?? 15,
    };
  }

  /** Remaining lockout in seconds, or 0 when the account is not locked. */
  private async lockedFor(userId: string): Promise<number> {
    const state = await this.prisma.loginLockout.findUnique({ where: { userId }, select: { lockedUntil: true } });
    if (!state || state.lockedUntil.getTime() <= Date.now()) return 0;
    return Math.ceil((state.lockedUntil.getTime() - Date.now()) / 1000);
  }

  private async recordLoginFailure(userId: string, ip: string): Promise<void> {
    const { max, minutes } = await this.lockoutPolicy();
    if (max <= 0) return;                       // 0 disables the policy
    const now = new Date();
    const windowStart = new Date(now.getTime() - minutes * 60_000);
    // One statement, so two failures at once both count.
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "LoginLockout" ("userId", "count", "lockedUntil", "updatedAt")
      VALUES (${userId}, 1, ${now}, ${now})
      ON CONFLICT ("userId") DO UPDATE SET
        "count" = CASE WHEN "LoginLockout"."lockedUntil" > ${windowStart} THEN "LoginLockout"."count" + 1 ELSE 1 END,
        "updatedAt" = ${now}
      RETURNING "count"`;
    const count = Number(rows[0]?.count ?? 1);
    const lockedUntil = new Date(count >= max ? now.getTime() + minutes * 60_000 : now.getTime());
    await this.prisma.loginLockout.updateMany({ where: { userId }, data: { lockedUntil } });
    if (count >= max) {
      await this.audit.log({
        action: 'LOGIN_FAILURE', actorId: userId, actorIp: ip,
        meta: { reason: 'account_locked', attempts: count, lockoutMinutes: minutes },
      });
    }
  }

  private async clearLoginFailures(userId: string): Promise<void> {
    await this.prisma.loginLockout.deleteMany({ where: { userId } });
  }

  // ── SSO enforcement (0.59) ───────────────────────────────────────────────

  /**
   * The sign-in mode that governs an account: its business's `ssoMode`, or
   * for staff (no business membership: Platform Admins, technicians) the
   * platform's `staffSsoMode`. Several memberships take the strictest.
   */
  async ssoModeFor(userId: string): Promise<{ mode: SsoMode; scope: 'business' | 'staff'; businessId: string | null }> {
    const ms = await this.prisma.membership.findMany({
      where: { userId, isActive: true, customerId: { not: null } },
      select: { customerId: true, customer: { select: { ssoMode: true } } },
    });
    if (ms.length) {
      const order: SsoMode[] = ['off', 'optional', 'required'];
      let best: { mode: SsoMode; businessId: string | null } = { mode: 'off', businessId: ms[0].customerId };
      for (const m of ms) {
        const raw = m.customer?.ssoMode;
        const mode: SsoMode = isSsoMode(raw) ? raw : 'off';
        if (order.indexOf(mode) > order.indexOf(best.mode)) best = { mode, businessId: m.customerId };
      }
      return { ...best, scope: 'business' };
    }
    const s = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { staffSsoMode: true } });
    const raw = s?.staffSsoMode;
    return { mode: isSsoMode(raw) ? raw : 'off', scope: 'staff', businessId: null };
  }

  /**
   * Refuse a password or Rem0te-passkey sign-in when the account's scope
   * requires SSO and the account is linked to an enabled provider. Checked
   * only after the credential itself verified, so it says nothing about an
   * account to someone without its password. A break-glass account is exempt.
   */
  async assertLocalSignInAllowed(user: { id: string; breakGlass?: boolean | null }, method: 'password' | 'passkey', ip: string): Promise<void> {
    const { mode, businessId } = await this.ssoModeFor(user.id);
    if (mode !== 'required') return;
    const linked = (await this.prisma.externalIdentity.count({ where: { userId: user.id, provider: { enabled: true } } })) > 0;
    if (!localSignInRefused({ mode, linked, breakGlass: user.breakGlass === true })) return;
    await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, customerId: businessId ?? undefined, meta: { reason: 'sso_required', method } });
    throw new ForbiddenException({ code: 'SSO_REQUIRED', message: 'Your organisation signs in with single sign-on. Use the single sign-on button instead.' });
  }

  /**
   * A break-glass account just got a session. The sealed audit entry is
   * written first and must succeed (logOrFail): no entry, no session. Then
   * the SSO module raises the security alert and emails Platform Admins.
   */
  private async breakGlassUsed(user: { id: string; breakGlass?: boolean | null }, method: string, ip: string, userAgent?: string) {
    if (user.breakGlass !== true) return;
    await this.audit.logOrFail({ action: 'BREAK_GLASS_LOGIN', actorId: user.id, actorIp: ip, actorAgent: userAgent, resource: 'user', resourceId: user.id, meta: { method } });
    await this.hooks.breakGlassSignIn?.(user.id, method, ip).catch((e: Error) => this.logger.error(`break-glass alert failed: ${e.message}`));
  }

  private partialSecret(): string {
    const base = this.config.get<string>('JWT_SECRET')!;
    return createHmac('sha256', base).update('rem0te:mfa-partial:v1').digest('hex');
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly mfaService: MfaService,
    private readonly audit: AuditService,
  ) {}

  async login(dto: LoginDto, ip: string, userAgent: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
      include: {
        memberships: {
          where: { isActive: true },
          include: { tenant: { select: { id: true, name: true, slug: true } }, role: true },
          // customerId is a scalar field on Membership, selected by default
        },
        mfaMethods: { where: { type: 'TOTP', isActive: true } },
      },
    });

    if (!user) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorIp: ip, meta: { email: dto.email, reason: 'user_not_found' } });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status === 'SUSPENDED') {
      throw new UnauthorizedException('Account is suspended');
    }
    if (user.status === 'INVITED') {
      throw new UnauthorizedException('Account setup not complete. Check your invitation email.');
    }
    // A deleted account is a deleted account. The strategy refuses its token on
    // the next request anyway, so letting the login itself succeed only ever
    // produced a confusing redirect loop.
    if (user.status === 'DELETED') {
      throw new UnauthorizedException('Invalid credentials');
    }

    const locked = await this.lockedFor(user.id);
    if (locked > 0) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, meta: { reason: 'locked_out' } });
      throw new UnauthorizedException(
        `Too many failed sign-in attempts. Try again in ${Math.ceil(locked / 60)} minute(s).`,
      );
    }

    // `!…` marks an account with no password at all (provisioned through SSO).
    if (!user.passwordHash || user.passwordHash.startsWith('!')) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, meta: { reason: 'no_password' } });
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password).catch(() => false);
    if (!valid) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, meta: { reason: 'invalid_password' } });
      await this.recordLoginFailure(user.id, ip);
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.clearLoginFailures(user.id);
    await this.assertLocalSignInAllowed(user, 'password', ip);
    return this.startSession(user, ip, userAgent, { method: 'password', mfaSatisfied: false });
  }

  /**
   * Refuse a sign-in for an account that may not have one. Shared by every
   * sign-in method, so SSO and passkeys can never reach a suspended account.
   */
  assertMaySignIn(user: { status: string }): void {
    if (user.status === 'SUSPENDED') throw new UnauthorizedException('Account is suspended');
    if (user.status === 'INVITED') throw new UnauthorizedException('Account setup not complete. Check your invitation email.');
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Invalid credentials');
  }

  /**
   * Sign in a user whose identity another method already proved (SSO, a
   * passkey). The account rules are the same as for a password: status, then
   * TOTP where the account has it or the tenant requires it — unless the
   * method itself satisfied multi-factor (a user-verified passkey).
   */
  async signInVerifiedUser(userId: string, ip: string, userAgent: string, method: 'sso' | 'passkey', mfaSatisfied: boolean, sso?: { ssoSessionId: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        memberships: { where: { isActive: true }, include: { tenant: { select: { id: true, name: true, slug: true } }, role: true } },
        mfaMethods: { where: { type: 'TOTP', isActive: true } },
      },
    });
    if (!user) throw new UnauthorizedException('Invalid credentials');
    this.assertMaySignIn(user);
    const locked = await this.lockedFor(user.id);
    if (locked > 0) throw new UnauthorizedException(`Too many failed sign-in attempts. Try again in ${Math.ceil(locked / 60)} minute(s).`);
    if (method === 'passkey') await this.assertLocalSignInAllowed(user, 'passkey', ip);
    return this.startSession(user, ip, userAgent, { method, mfaSatisfied, sso });
  }

  private async startSession(
    user: {
      id: string; email: string; firstName: string | null; lastName: string | null; isPlatformAdmin: boolean; sessionsValidAfter?: Date | null; breakGlass?: boolean | null;
      memberships: { tenantId: string; customerId: string | null; capabilities: string[]; role: { type: unknown } }[];
      mfaMethods: unknown[];
    },
    ip: string, userAgent: string,
    opts: { method: 'password' | 'sso' | 'passkey'; mfaSatisfied: boolean; sso?: { ssoSessionId: string } },
  ) {
    let tenantId: string | null = null;
    let roleType = null;
    let businessId: string | null = null;
    let capabilities: string[] = [];

    // A person belongs to exactly one business, so there is nothing to pick.
    if (user.memberships.length === 1) {
      tenantId = user.memberships[0].tenantId;
      roleType = user.memberships[0].role.type;
      businessId = user.memberships[0].customerId ?? null;
      capabilities = user.memberships[0].capabilities ?? [];
    } else if (user.memberships.length === 0) {
      // Platform admins, and MSP technicians whose access is entirely through
      // technician assignments, have no membership. The JWT strategy decides
      // per request whether there is anything to act on; a user with neither
      // a membership, an assignment nor a platform permission is refused
      // there on the very first request.
      // Platform admins don't need a membership. Rem0te has one platform
      // operator; the businesses it manages are Customer rows. Fall back to
      // the platform container so an admin can create and manage businesses
      // without a placeholder membership.
      const t = await this.prisma.tenant.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (t) tenantId = t.id;
    }

    // A Business Owner / Business User with no business cannot do anything —
    // say so at login rather than handing out a token that 403s everywhere.
    if (!user.isPlatformAdmin && roleType && !businessId) {
      this.logger.warn(`User ${user.email} has a membership with no business assigned`);
    }

    const hasTotpMethod = user.mfaMethods.length > 0;

    let requireMfa = false;
    if (tenantId) {
      const settings = await this.prisma.tenantSettings.findUnique({
        where: { tenantId },
        select: { requireMfa: true },
      });
      requireMfa = settings?.requireMfa ?? false;
    }

    if (!opts.mfaSatisfied && (hasTotpMethod || requireMfa)) {
      const partialToken = this.jwtService.sign(
        {
          sub: user.id, email: user.email, tenantId, roleType,
          isPlatformAdmin: user.isPlatformAdmin, mfaVerified: false, partial: true,
          // 0.59: the SSO session this sign-in started, bound once TOTP passes.
          ...(opts.sso ? { sso: opts.sso.ssoSessionId } : {}),
        },
        { expiresIn: '10m', secret: this.partialSecret() },
      );
      return { requiresMfa: true, mfaEnrolled: hasTotpMethod, partialToken };
    }

    // A passkey sign-in satisfies MFA itself; a password or SSO sign-in that
    // reached here did not pass a second factor (none is enrolled or required).
    const token = this.issueFullToken(user, tenantId, roleType, businessId, capabilities, opts.mfaSatisfied);
    if (opts.sso) await this.bindSsoSession(opts.sso.ssoSessionId, user.id, this.iatOf(token));
    await this.breakGlassUsed(user, opts.method, ip, userAgent);
    await this.audit.log({
      action: 'LOGIN_SUCCESS', actorId: user.id,
      tenantId: tenantId ?? undefined, customerId: businessId ?? undefined,
      actorIp: ip, actorAgent: userAgent, meta: { method: opts.method },
    });

    return {
      requiresMfa: false,
      accessToken: token,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    };
  }

  async verifyMfaAndLogin(partialToken: string, code: string, ip: string) {
    let payload: JwtPayload & { partial?: boolean; sso?: string };
    try {
      payload = this.jwtService.verify(partialToken, { secret: this.partialSecret() });
    } catch {
      throw new UnauthorizedException('Invalid or expired partial token');
    }

    if (!payload.partial) throw new BadRequestException('Token is not a partial token');

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        memberships: {
          where: { isActive: true },
          include: { tenant: { select: { id: true, name: true, slug: true } }, role: true },
        },
      },
    });
    if (!user) throw new UnauthorizedException();

    const verified = await this.mfaService.verifyTotp(user.id, code);
    if (!verified) {
      await this.audit.log({ action: 'LOGIN_FAILURE', actorId: user.id, actorIp: ip, meta: { reason: 'invalid_totp' } });
      throw new UnauthorizedException('Invalid MFA code');
    }

    await this.audit.log({ action: 'MFA_VERIFIED', actorId: user.id, tenantId: payload.tenantId ?? undefined, actorIp: ip });
    await this.audit.log({ action: 'LOGIN_SUCCESS', actorId: user.id, tenantId: payload.tenantId ?? undefined, actorIp: ip });

    // Resolve business + capabilities from the matching membership — the
    // partial token deliberately does not carry them.
    const matchingMembership = payload.tenantId
      ? user.memberships.find((m) => m.tenantId === payload.tenantId)
      : user.memberships[0];

    const token = this.issueFullToken(
      user,
      payload.tenantId,
      matchingMembership?.role.type ?? payload.roleType,
      matchingMembership?.customerId ?? null,
      matchingMembership?.capabilities ?? [],
      true, // the TOTP code above
    );
    if (typeof payload.sso === 'string') await this.bindSsoSession(payload.sso, user.id, this.iatOf(token));
    await this.breakGlassUsed(user, 'totp', ip);
    return {
      accessToken: token,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    };
  }

  async register(dto: RegisterDto): Promise<void> {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (exists) throw new ConflictException('Email already registered');

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 4 });

    await this.prisma.user.create({
      data: { email: dto.email.toLowerCase(), passwordHash, firstName: dto.firstName, lastName: dto.lastName },
    });
  }

  private issueFullToken(
    user: { id: string; email: string; isPlatformAdmin: boolean; sessionsValidAfter?: Date | null },
    tenantId: string | null,
    roleType: unknown,
    businessId: string | null | undefined,
    capabilities: string[] | null | undefined,
    /** Whether THIS sign-in passed a second factor. Never assumed. */
    mfaVerified: boolean,
  ): string {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tenantId,
      roleType: roleType as JwtPayload['roleType'],
      isPlatformAdmin: user.isPlatformAdmin,
      mfaVerified,
      businessId: businessId ?? null,
      // Legacy alias so a token minted here still resolves on older code paths.
      customerId: businessId ?? null,
      capabilities: capabilities ?? [],
      // Never earlier than the account's last revocation, or a sign-in in
      // the same second as a sign-out would mint an already-dead token.
      iat: issueAt(user.sessionsValidAfter),
    };
    return this.jwtService.sign(payload);
  }

  private iatOf(token: string): number | undefined {
    const d = this.jwtService.decode(token) as { iat?: number } | null;
    return typeof d?.iat === 'number' ? d.iat : undefined;
  }

  /** Tie an SSO sign-in to the session token it produced (once). */
  private async bindSsoSession(ssoSessionId: string, userId: string, sessionIat: number | undefined) {
    if (sessionIat === undefined) return;
    await this.prisma.ssoSession.updateMany({ where: { id: ssoSessionId, userId, sessionIat: null, endedAt: null }, data: { sessionIat } });
  }

  async getProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        status: true, createdAt: true, isPlatformAdmin: true,
        phone: true, jobTitle: true,
        address: true, city: true, state: true, country: true, postalCode: true,
        timeZone: true,
      },
    });
  }

  async updateProfile(
    userId: string,
    data: {
      firstName?: string; lastName?: string; email?: string;
      phone?: string; jobTitle?: string;
      address?: string; city?: string; state?: string; country?: string; postalCode?: string;
      timeZone?: string; currentPassword?: string;
    },
  ) {
    const { currentPassword, ...fields } = data;
    data = fields;
    if (data.email) {
      const current = await this.prisma.user.findUnique({
        where: { id: userId }, select: { email: true, passwordHash: true },
      });
      if (current && data.email.toLowerCase() !== current.email.toLowerCase()) {
        const ok = !!currentPassword && !!current.passwordHash
          && await argon2.verify(current.passwordHash, currentPassword).catch(() => false);
        if (!ok) throw new BadRequestException('Enter your current password to change your email address');
      }
      const clash = await this.prisma.user.findFirst({
        where: { email: data.email.toLowerCase(), NOT: { id: userId } },
      });
      if (clash) throw new BadRequestException('Email already in use');
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(data.firstName  !== undefined && { firstName:  data.firstName }),
        ...(data.lastName   !== undefined && { lastName:   data.lastName  }),
        ...(data.email      !== undefined && { email:      data.email.toLowerCase() }),
        ...(data.phone      !== undefined && { phone:      data.phone || null }),
        ...(data.jobTitle   !== undefined && { jobTitle:   data.jobTitle || null }),
        ...(data.address    !== undefined && { address:    data.address || null }),
        ...(data.city       !== undefined && { city:       data.city || null }),
        ...(data.state      !== undefined && { state:      data.state || null }),
        ...(data.country    !== undefined && { country:    data.country || null }),
        ...(data.postalCode !== undefined && { postalCode: data.postalCode || null }),
        ...(data.timeZone   !== undefined && { timeZone:   data.timeZone || null }),
      },
      select: {
        id: true, email: true, firstName: true, lastName: true,
        phone: true, jobTitle: true,
        address: true, city: true, state: true, country: true, postalCode: true, timeZone: true,
      },
    });
    await this.audit.log({ actorId: userId, action: 'USER_UPDATED', resource: 'user', resourceId: userId, meta: { self: true, fields: Object.keys(data) } });
    return updated;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, mfaVerified = false) {
    if (!newPassword || newPassword.length < 12) throw new BadRequestException('Password must be at least 12 characters');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (!user.passwordHash || user.passwordHash.startsWith('!')) throw new BadRequestException('No password set on this account');
    const valid = await argon2.verify(user.passwordHash, currentPassword).catch(() => false);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');
    const passwordHash = await argon2.hash(newPassword);
    const sessionsValidAfter = revocationInstant();
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash, sessionsValidAfter } });
    await this.audit.log({ actorId: userId, action: 'PASSWORD_CHANGED', resource: 'user', resourceId: userId, meta: { self: true } });

    // A replacement for the caller's own session, minted after the revocation
    // so it outlives it. Built the way login builds one.
    const membership = await this.prisma.membership.findFirst({
      where: { userId, isActive: true },
      select: { tenantId: true, customerId: true, capabilities: true, role: { select: { type: true } } },
    });
    let tenantId = membership?.tenantId ?? null;
    if (!tenantId && user.isPlatformAdmin) {
      tenantId = (await this.prisma.tenant.findFirst({
        where: { isActive: true }, orderBy: { createdAt: 'asc' }, select: { id: true },
      }))?.id ?? null;
    }
    const accessToken = this.issueFullToken(
      { ...user, sessionsValidAfter }, tenantId, membership?.role.type ?? null, membership?.customerId ?? null, membership?.capabilities ?? [],
      // The replacement keeps what the session it replaces had proven.
      mfaVerified,
    );
    return { success: true, accessToken };
  }

  /**
   * Re-authenticate an already signed-in user for a sensitive action.
   * Password or a TOTP code; passkeys go through PasskeysController.
   * Failures count toward the same lockout as sign-in.
   */
  async verifyStepUp(userId: string, input: { password?: string; totpCode?: string }, ip: string): Promise<string> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, passwordHash: true, status: true } });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    const locked = await this.lockedFor(user.id);
    if (locked > 0) throw new UnauthorizedException(`Too many failed attempts. Try again in ${Math.ceil(locked / 60)} minute(s).`);

    // An enrolled authenticator is the stronger proof; accepting the
    // password instead would let anyone holding a stolen session AND the
    // password step up without it. Passkeys go through their own route.
    const hasTotp = await this.hasTotp(user.id);
    if (hasTotp && !input.totpCode) {
      await this.audit.log({ action: 'STEP_UP_FAILED', actorId: user.id, actorIp: ip, meta: { method: input.password ? 'password' : 'none', reason: 'totp_required' } });
      throw new UnauthorizedException({ code: 'TOTP_REQUIRED', message: 'Your account has an authenticator: enter its code, or use a passkey.' });
    }

    let ok = false;
    let method = '';
    if (input.totpCode) {
      ok = await this.mfaService.verifyTotp(user.id, input.totpCode);
      method = 'totp';
    } else if (input.password) {
      ok = !!user.passwordHash && await argon2.verify(user.passwordHash, input.password).catch(() => false);
      method = 'password';
    }
    if (!ok) {
      await this.recordLoginFailure(user.id, ip);
      await this.audit.log({ action: 'STEP_UP_FAILED', actorId: user.id, actorIp: ip, meta: { method: method || 'none' } });
      throw new UnauthorizedException('That did not match. Try again.');
    }
    await this.clearLoginFailures(user.id);
    await this.audit.log({ action: 'STEP_UP_VERIFIED', actorId: user.id, actorIp: ip, meta: { method } });
    return method;
  }

  /** Whether step-up for this person must use the authenticator rather than the password. */
  async hasTotp(userId: string): Promise<boolean> {
    return (await this.prisma.userMfaMethod.count({ where: { userId, type: 'TOTP', isActive: true } })) > 0;
  }

  async revokeSessions(userId: string, reason = 'revoked'): Promise<void> {
    const at = revocationInstant();
    // Revocation is per second. A session minted after one revocation gets an
    // iat equal to the revocation point (issueAt), so a second revocation in
    // the same second must move the point past it, or that session survives
    // (0.59: a back-channel logout right after a sign-in hit this). Always
    // strictly later than the previous point, never earlier than now.
    await this.prisma.$executeRaw`UPDATE "User" SET "sessionsValidAfter" = GREATEST(${at}::timestamp, COALESCE("sessionsValidAfter" + interval '1 second', ${at}::timestamp)) WHERE "id" = ${userId}`;
    // Every SSO sign-in of the account ended with it: nothing left to check or log out.
    await this.prisma.ssoSession.updateMany({ where: { userId, endedAt: null }, data: { endedAt: at, endReason: reason.slice(0, 40) } });
  }

  /**
   * Sign-out (0.59: and RP-initiated logout). The provider's end-session URL
   * is read before the revocation ends the SSO session it belongs to; it is
   * returned for the browser to follow, never fetched from here.
   */
  async logout(userId: string, sessionIat: number | undefined): Promise<{ redirectTo: string | null }> {
    let redirectTo: string | null;
    try { redirectTo = (await this.hooks.endSessionUrl?.(userId, sessionIat)) ?? null; } catch { redirectTo = null; }
    await this.revokeSessions(userId, 'sign_out');
    return { redirectTo };
  }
}
