import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { EmailService } from '../email/email.service';
import { SecurityAlertService } from '../security-controls/alerts.service';
import { ControlsStore } from '../security-controls/controls.store';
import type { ActorContext } from '../rbac/access-control.service';
import { MAX_BREAK_GLASS, isSsoMode, type SsoMode } from './identity-policy';

const ID = /^[a-z0-9]{8,40}$/i;

/**
 * The Platform Admin side of identity (0.59):
 *
 *   link suggestions   an IdP identity whose verified email matches an
 *                      unlinked account, confirmed one at a time (fresh
 *                      authentication, `sso.configure`), never automatically;
 *   ssoMode            per business, and for staff: off | optional | required.
 *                      `required` only when every active account in scope is
 *                      linked (`sso.enforce`); lowering never asks; the
 *                      recovery CLI lowers it from the host;
 *   break-glass        at most two Platform Admins with TOTP and a passkey,
 *                      exempt from `required` (`breakglass.manage`); every
 *                      sign-in is a sealed audit entry, a security alert and
 *                      an email to Platform Admins.
 *
 * Email goes only to mailbox-confirmed recipients (§42): a Platform Admin is
 * emailed when their account address is a confirmed global recipient, and a
 * linked person when theirs is a confirmed recipient in any scope.
 */
@Injectable()
export class SsoIdentityService implements OnModuleInit {
  private readonly logger = new Logger('SsoIdentity');
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly email: EmailService,
    private readonly alerts: SecurityAlertService,
    private readonly controls: ControlsStore,
  ) {}

  onModuleInit() {
    this.auth.setHooks({ breakGlassSignIn: (u, m, ip) => this.breakGlassSignIn(u, m, ip) });
  }

  private assertAdmin(actor: ActorContext) {
    if (!actor.isPlatformAdmin || actor.technician) throw new ForbiddenException('Only a Platform Admin can manage sign-in enforcement');
  }

  // ── Email, only to confirmed recipients ─────────────────────────────────

  private async mailConfirmed(addresses: string[], scopeKeys: string[] | null, subject: string, text: string) {
    if (!addresses.length) return 0;
    const rows = await this.prisma.emailRecipient.findMany({
      where: { address: { in: addresses.map((a) => a.toLowerCase()) }, verifiedAt: { not: null }, ...(scopeKeys ? { scopeKey: { in: scopeKeys } } : {}) },
      select: { id: true, scopeKey: true, address: true, customerId: true },
    });
    const seen = new Set<string>();
    let sent = 0;
    for (const r of rows) {
      if (seen.has(r.address)) continue;
      seen.add(r.address);
      const res = await this.email.sendToRecipients([r.id], r.scopeKey, { subject, text }, { customerId: r.customerId });
      if (res[0]?.ok) sent++;
    }
    return sent;
  }

  private async breakGlassSignIn(userId: string, method: string, ip: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    const controls = await this.controls.platform();
    await this.alerts.raise({
      kind: 'break_glass_login', identity: `user:${userId}`,
      details: { userId, method },
      destinations: controls.alertDestinations,
    });
    const admins = await this.prisma.user.findMany({ where: { isPlatformAdmin: true, status: 'ACTIVE' }, select: { email: true }, take: 50 });
    const sent = await this.mailConfirmed(admins.map((a) => a.email), ['global'],
      'Rem0te: a break-glass account signed in',
      `The break-glass account ${u?.email ?? userId} signed in (${method}) from ${ip} at ${new Date().toISOString()}.\n\n`
      + 'Break-glass accounts are for when single sign-on is unavailable. If this was not expected, review it under Settings → Audit log and end the session from the Users page.\n');
    this.logger.warn(`break-glass sign-in by ${userId} (${method}); ${sent} admin email(s) sent`);
  }

  // ── Link suggestions ─────────────────────────────────────────────────────

  async suggestions(actor: ActorContext) {
    this.assertAdmin(actor);
    const rows = await this.prisma.ssoLinkSuggestion.findMany({
      where: { status: 'PENDING' }, orderBy: { lastSeenAt: 'desc' }, take: 200,
      select: {
        id: true, email: true, createdAt: true, lastSeenAt: true,
        provider: { select: { id: true, name: true } },
        user: { select: { id: true, email: true, firstName: true, lastName: true, status: true } },
      },
    });
    return rows;
  }

  async confirmSuggestion(actor: ActorContext, id: string) {
    this.assertAdmin(actor);
    if (!ID.test(id)) throw new NotFoundException('Suggestion not found');
    const s = await this.prisma.ssoLinkSuggestion.findUnique({ where: { id }, include: { provider: true, user: { select: { id: true, email: true, status: true, isPlatformAdmin: true, breakGlass: true } } } });
    if (!s || s.status !== 'PENDING') throw new NotFoundException('Suggestion not found');
    if (s.user.status !== 'ACTIVE' || s.user.isPlatformAdmin || s.user.breakGlass) throw new ConflictException({ code: 'SUGGESTION_NOT_LINKABLE', message: 'That account can no longer be linked this way.' });
    if (await this.prisma.externalIdentity.findUnique({ where: { issuer_subject: { issuer: s.issuer, subject: s.subject } } })) {
      throw new ConflictException({ code: 'SSO_IDENTITY_LINKED_ELSEWHERE', message: 'That identity is already linked to an account.' });
    }
    if (await this.prisma.externalIdentity.count({ where: { userId: s.userId, providerId: s.providerId } })) {
      throw new ConflictException({ code: 'SSO_ACCOUNT_ALREADY_LINKED', message: 'That account is already linked at this provider.' });
    }
    // Conditional: only the request that moves it from PENDING links it.
    const claimed = await this.prisma.ssoLinkSuggestion.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'LINKED', decidedById: actor.userId, decidedAt: new Date() } });
    if (claimed.count !== 1) throw new NotFoundException('Suggestion not found');
    await this.prisma.externalIdentity.create({ data: { userId: s.userId, providerId: s.providerId, issuer: s.issuer, subject: s.subject, email: s.email } });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'SSO_LINKED', resource: 'oidc_provider', resourceId: s.providerId, meta: { by: 'admin', userId: s.userId, suggestionId: id } });
    const notified = await this.mailConfirmed([s.user.email], null,
      'Rem0te: single sign-on was linked to your account',
      `An administrator linked your Rem0te account to ${s.provider.name}. You can now sign in with it.\n\nIf you did not expect this, tell your administrator; you can unlink it from My Account → Single sign-on.\n`);
    return { linked: true, notified: notified > 0 };
  }

  async dismissSuggestion(actor: ActorContext, id: string) {
    this.assertAdmin(actor);
    if (!ID.test(id)) throw new NotFoundException('Suggestion not found');
    const r = await this.prisma.ssoLinkSuggestion.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'DISMISSED', decidedById: actor.userId, decidedAt: new Date() } });
    if (!r.count) throw new NotFoundException('Suggestion not found');
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'SSO_LINK_SUGGESTION_DISMISSED', resource: 'oidc_provider', meta: { suggestionId: id } });
    return { dismissed: true };
  }

  // ── Enforcement ──────────────────────────────────────────────────────────

  /** Active accounts in a scope, and how many are not linked to an enabled provider (break-glass not counted). */
  async coverage(scope: 'staff' | string) {
    const linked = { externalIdentities: { some: { provider: { enabled: true } } } };
    const base = scope === 'staff'
      ? { status: 'ACTIVE' as const, breakGlass: false, memberships: { none: { isActive: true, customerId: { not: null } } } }
      : { status: 'ACTIVE' as const, breakGlass: false, memberships: { some: { isActive: true, customerId: scope } } };
    const [total, linkedCount] = await Promise.all([
      this.prisma.user.count({ where: base }),
      this.prisma.user.count({ where: { ...base, ...linked } }),
    ]);
    return { total, linked: linkedCount, unlinked: total - linkedCount };
  }

  async enforcement(actor: ActorContext) {
    this.assertAdmin(actor);
    const s = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { staffSsoMode: true } });
    const businesses = await this.prisma.customer.findMany({ where: { isArchived: false }, select: { id: true, name: true, ssoMode: true }, orderBy: { name: 'asc' }, take: 500 });
    return {
      staff: { mode: s?.staffSsoMode ?? 'off', ...(await this.coverage('staff')) },
      businesses: await Promise.all(businesses.map(async (b) => ({ id: b.id, name: b.name, mode: b.ssoMode, ...(await this.coverage(b.id)) }))),
      breakGlass: await this.breakGlassList(),
      enabledProviders: await this.prisma.oidcProvider.count({ where: { enabled: true } }),
    };
  }

  /** Whether moving to `mode` widens what is refused (needs fresh authentication). */
  static tightens(before: string, after: SsoMode) { return after === 'required' && before !== 'required'; }

  async setMode(actor: ActorContext, scope: string, raw: unknown) {
    this.assertAdmin(actor);
    if (!isSsoMode(raw)) throw new BadRequestException({ code: 'INVALID_SSO_MODE', message: 'mode must be off, optional or required' });
    const mode: SsoMode = raw;
    let before: string;
    if (scope === 'staff') {
      before = (await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { staffSsoMode: true } }))?.staffSsoMode ?? 'off';
    } else {
      if (!ID.test(scope)) throw new NotFoundException('Business not found');
      const b = await this.prisma.customer.findUnique({ where: { id: scope }, select: { ssoMode: true } });
      if (!b) throw new NotFoundException('Business not found');
      before = b.ssoMode;
    }
    return { before, mode, tightens: SsoIdentityService.tightens(before, mode) };
  }

  /** Called after the fresh-authentication check when it tightens. */
  async applyMode(actor: ActorContext, scope: string, plan: { before: string; mode: SsoMode }) {
    if (plan.mode === 'required') {
      if (!(await this.prisma.oidcProvider.count({ where: { enabled: true } }))) {
        throw new ConflictException({ code: 'SSO_ENFORCE_NO_PROVIDER', message: 'Enable a sign-in provider before requiring it.' });
      }
      const cov = await this.coverage(scope);
      if (cov.unlinked > 0) {
        throw new ConflictException({ code: 'SSO_ENFORCE_UNLINKED', unlinked: cov.unlinked, message: `${cov.unlinked} active account(s) in this scope are not linked to an enabled provider. Link them first.` });
      }
      if (scope === 'staff') {
        // Staff includes Platform Admins: without a provider that admits them,
        // `required` would leave only break-glass — so there must be one, and
        // the admins must have a way in.
        if ((await this.prisma.user.count({ where: { breakGlass: true, status: 'ACTIVE' } })) === 0) {
          throw new ConflictException({ code: 'SSO_ENFORCE_NO_BREAK_GLASS', message: 'Set up a break-glass account before requiring single sign-on for staff.' });
        }
        const admins = await this.prisma.user.count({ where: { isPlatformAdmin: true, breakGlass: false, status: 'ACTIVE' } });
        if (admins > 0 && !(await this.prisma.oidcProvider.count({ where: { enabled: true, allowPlatformAdmin: true } }))) {
          throw new ConflictException({ code: 'SSO_ENFORCE_ADMIN_LOCKOUT', message: 'No enabled provider lets a Platform Admin sign in, so requiring single sign-on would lock the Platform Admins out.' });
        }
      }
    }
    if (scope === 'staff') {
      await this.prisma.platformSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', staffSsoMode: plan.mode }, update: { staffSsoMode: plan.mode } });
    } else {
      // Conditional on the value read, so two admins cannot race past the coverage check.
      const r = await this.prisma.customer.updateMany({ where: { id: scope, ssoMode: plan.before }, data: { ssoMode: plan.mode } });
      if (r.count !== 1) throw new ConflictException({ code: 'SSO_MODE_CHANGED_MEANWHILE', message: 'The sign-in mode changed meanwhile. Reload and try again.' });
    }
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'SSO_MODE_CHANGED', resource: scope === 'staff' ? 'platform_settings' : 'customer',
      resourceId: scope === 'staff' ? 'singleton' : scope, customerId: scope === 'staff' ? undefined : scope,
      meta: { scope: scope === 'staff' ? 'staff' : 'business', before: plan.before, after: plan.mode },
    });
    return { mode: plan.mode };
  }

  // ── Break-glass ──────────────────────────────────────────────────────────

  async breakGlassList() {
    const rows = await this.prisma.user.findMany({
      where: { isPlatformAdmin: true, status: 'ACTIVE' }, orderBy: { email: 'asc' }, take: 100,
      select: { id: true, email: true, firstName: true, lastName: true, breakGlass: true, mfaMethods: { where: { isActive: true }, select: { type: true } } },
    });
    return rows.map((r) => ({
      id: r.id, email: r.email, name: `${r.firstName} ${r.lastName}`.trim(), breakGlass: r.breakGlass,
      hasTotp: r.mfaMethods.some((m) => m.type === 'TOTP'), hasPasskey: r.mfaMethods.some((m) => m.type === 'WEBAUTHN'),
    }));
  }

  /** Check a break-glass change before the fresh-authentication check. */
  async planBreakGlass(actor: ActorContext, userId: string, on: unknown) {
    this.assertAdmin(actor);
    if (typeof on !== 'boolean') throw new BadRequestException({ code: 'INVALID_REQUEST', message: 'breakGlass must be true or false' });
    if (!ID.test(userId)) throw new NotFoundException('User not found');
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true, isPlatformAdmin: true, breakGlass: true, mfaMethods: { where: { isActive: true }, select: { type: true } } } });
    if (!u) throw new NotFoundException('User not found');
    if (on) {
      if (!u.isPlatformAdmin || u.status !== 'ACTIVE') throw new ConflictException({ code: 'BREAK_GLASS_NOT_ADMIN', message: 'A break-glass account must be an active Platform Admin.' });
      if (!u.mfaMethods.some((m) => m.type === 'TOTP') || !u.mfaMethods.some((m) => m.type === 'WEBAUTHN')) {
        throw new ConflictException({ code: 'BREAK_GLASS_NEEDS_FACTORS', message: 'A break-glass account needs an authenticator (TOTP) and a passkey enrolled first.' });
      }
      if (!u.breakGlass && (await this.prisma.user.count({ where: { breakGlass: true } })) >= MAX_BREAK_GLASS) {
        throw new ConflictException({ code: 'BREAK_GLASS_LIMIT', message: `At most ${MAX_BREAK_GLASS} break-glass accounts.` });
      }
    }
    return { before: u.breakGlass, after: on };
  }

  async applyBreakGlass(actor: ActorContext, userId: string, plan: { before: boolean; after: boolean }) {
    if (plan.before === plan.after) return { breakGlass: plan.after };
    try {
      const r = await this.prisma.user.updateMany({ where: { id: userId, breakGlass: plan.before }, data: { breakGlass: plan.after } });
      if (r.count !== 1) throw new ConflictException({ code: 'BREAK_GLASS_CHANGED_MEANWHILE', message: 'That account changed meanwhile. Reload and try again.' });
    } catch (e) {
      if (e instanceof ConflictException) throw e;
      // 0080's trigger and CHECK are the last word on the limit and the role.
      throw new ConflictException({ code: 'BREAK_GLASS_LIMIT', message: `At most ${MAX_BREAK_GLASS} break-glass accounts, each an active Platform Admin.` });
    }
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'BREAK_GLASS_CHANGED', resource: 'user', resourceId: userId, meta: { before: plan.before, after: plan.after } });
    return { breakGlass: plan.after };
  }
}
