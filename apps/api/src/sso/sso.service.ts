import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import * as oidc from 'openid-client';
import type { OidcProvider } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { ActorContext } from '../rbac/access-control.service';
import { sanitizeCapabilities } from '../rbac/capabilities';
import { safeReturnTo } from '../auth/cookies';
import { PublicUrlService } from '../platform/public-url.service';

const STATE_TTL_MS = 10 * 60_000;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A refusal the callback turns into `/login?sso_error=<code>`. Never carries provider detail. */
export class SsoError extends Error {
  /** Set when the failed round trip was a signed-in user linking: send them back to their account, not to sign-in. */
  linkFlow = false;
  constructor(public readonly code: string, detail?: string) { super(detail ?? code); }
}

export interface ProviderInput {
  name?: string; issuer?: string; clientId?: string; clientSecret?: string | null;
  redirectUri?: string; scopes?: string; enabled?: boolean; allowProvisioning?: boolean; groupsClaim?: string | null;
}

/**
 * OpenID Connect sign-in (authorization code + PKCE, via openid-client).
 *
 * Account matching is by (issuer, subject) and nothing else. An email address
 * from the provider is never used to find or link an account: someone who
 * controls an IdP, or an IdP that lets users set their own email, could
 * otherwise take over any account by naming its address.
 *
 * So an identity reaches an account one of two ways:
 *   linked       a signed-in user (after step-up) starts a LINK round trip
 *                and the identity that comes back is attached to them;
 *   provisioned  only if the provider allows it, a NEW account with a
 *                verified email no other account has — with no business and
 *                no permissions unless an explicit group mapping grants one.
 *
 * The rest of sign-in is the password path's: account status, the lockout,
 * and TOTP when the account has it or the tenant requires it. Password
 * sign-in stays available whatever is configured here, and
 * dist/cli/auth-recovery.js (src/cli/auth-recovery.ts) disables every provider from the host.
 */
@Injectable()
export class SsoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SsoService.name);
  private readonly key: Buffer;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cache = new Map<string, { stamp: number; at: number; cfg: oidc.Configuration }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly urls: PublicUrlService,
  ) {
    this.key = Buffer.from(this.config.get<string>('ENCRYPTION_KEY') ?? '', 'hex');
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      this.prisma.oidcLoginState.deleteMany({ where: { expiresAt: { lt: new Date() } } })
        .catch((e) => this.logger.error('OIDC state cleanup failed', e));
    }, 10 * 60_000);
    this.timer.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ── Secrets ─────────────────────────────────────────────────────────────

  private enc(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const e = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return `${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${e.toString('hex')}`;
  }
  private dec(data: string): string {
    const [iv, tag, e] = data.split(':').map((h) => Buffer.from(h, 'hex'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    return d.update(e).toString('utf8') + d.final('utf8');
  }

  // ── Provider configuration (Platform Admin) ────────────────────────────

  private isLoopback(u: URL) {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  }
  private insecureAllowed(u: URL) {
    return this.config.get<string>('OIDC_ALLOW_INSECURE_LOOPBACK') === 'true' && this.isLoopback(u);
  }
  private checkUrl(label: string, v: string): URL {
    let u: URL;
    try { u = new URL(v); } catch { throw new BadRequestException(`${label} is not a URL`); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.insecureAllowed(u))) {
      throw new BadRequestException(`${label} must use https://`);
    }
    if (u.username || u.password || u.hash) throw new BadRequestException(`${label} must not contain credentials or a fragment`);
    return u;
  }

  private view(p: OidcProvider & { groupMappings?: { id: string; groupValue: string; customerId: string; capabilities: string[] }[]; _count?: { identities: number } }) {
    return {
      id: p.id, name: p.name, issuer: p.issuer, clientId: p.clientId, hasClientSecret: !!p.clientSecretEnc,
      redirectUri: p.redirectUri, scopes: p.scopes, enabled: p.enabled, allowProvisioning: p.allowProvisioning,
      groupsClaim: p.groupsClaim, groupMappings: p.groupMappings ?? [], linkedAccounts: p._count?.identities ?? 0,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
    };
  }

  private assertAdmin(actor: ActorContext) {
    if (!actor.isPlatformAdmin || actor.technician) throw new ForbiddenException('Only a Platform Admin can configure sign-in providers');
  }

  /** The redirect URI to register at the provider, for the admin form. */
  suggestedRedirectUri() {
    return `${this.urls.web()}/api/v1/auth/sso/callback`;
  }

  async listProviders(actor: ActorContext) {
    this.assertAdmin(actor);
    const rows = await this.prisma.oidcProvider.findMany({
      orderBy: { name: 'asc' }, include: { groupMappings: true, _count: { select: { identities: true } } },
    });
    return { providers: rows.map((r) => this.view(r)), suggestedRedirectUri: this.suggestedRedirectUri() };
  }

  async createProvider(actor: ActorContext, dto: ProviderInput) {
    this.assertAdmin(actor);
    if (!dto.name?.trim() || !dto.issuer || !dto.clientId || !dto.redirectUri) {
      throw new BadRequestException('name, issuer, clientId and redirectUri are required');
    }
    this.checkUrl('Issuer', dto.issuer);
    this.checkUrl('Redirect URI', dto.redirectUri);
    if (await this.prisma.oidcProvider.findUnique({ where: { issuer: dto.issuer } })) {
      throw new ConflictException('A provider with this issuer already exists');
    }
    const p = await this.prisma.oidcProvider.create({
      data: {
        name: dto.name.trim().slice(0, 80), issuer: dto.issuer, clientId: dto.clientId,
        clientSecretEnc: dto.clientSecret ? this.enc(dto.clientSecret) : null,
        redirectUri: dto.redirectUri, scopes: this.scopes(dto.scopes),
        // Created disabled, always: enable it after a test sign-in works.
        enabled: false, allowProvisioning: dto.allowProvisioning === true, groupsClaim: dto.groupsClaim?.trim() || null,
      },
    });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'SSO_PROVIDER_CHANGED', resource: 'oidc_provider', resourceId: p.id, meta: { op: 'create', issuer: p.issuer } });
    return this.view(p);
  }

  private scopes(v?: string) {
    const list = (v ?? 'openid email profile').split(/\s+/).filter((x) => /^[\x21-\x7e]{1,64}$/.test(x)).slice(0, 20);
    if (!list.includes('openid')) list.unshift('openid');
    return [...new Set(list)].join(' ');
  }

  async updateProvider(actor: ActorContext, id: string, dto: ProviderInput) {
    this.assertAdmin(actor);
    const cur = await this.prisma.oidcProvider.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Provider not found');
    if (dto.issuer && dto.issuer !== cur.issuer) {
      // Identities are keyed by issuer; changing it would orphan or, worse,
      // re-point every linked account. Add a new provider instead.
      throw new BadRequestException('The issuer cannot be changed. Add a new provider instead.');
    }
    if (dto.redirectUri) this.checkUrl('Redirect URI', dto.redirectUri);
    const p = await this.prisma.oidcProvider.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim().slice(0, 80) } : {}),
        ...(dto.clientId !== undefined ? { clientId: dto.clientId } : {}),
        ...(dto.clientSecret !== undefined ? { clientSecretEnc: dto.clientSecret ? this.enc(dto.clientSecret) : null } : {}),
        ...(dto.redirectUri !== undefined ? { redirectUri: dto.redirectUri } : {}),
        ...(dto.scopes !== undefined ? { scopes: this.scopes(dto.scopes) } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(dto.allowProvisioning !== undefined ? { allowProvisioning: dto.allowProvisioning } : {}),
        ...(dto.groupsClaim !== undefined ? { groupsClaim: dto.groupsClaim?.trim() || null } : {}),
      },
    });
    this.cache.delete(id);
    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip, action: 'SSO_PROVIDER_CHANGED', resource: 'oidc_provider', resourceId: id,
      meta: { op: 'update', fields: Object.keys(dto).filter((k) => k !== 'clientSecret').concat(dto.clientSecret !== undefined ? ['clientSecret'] : []) },
    });
    return this.view(p);
  }

  async deleteProvider(actor: ActorContext, id: string) {
    this.assertAdmin(actor);
    const r = await this.prisma.oidcProvider.deleteMany({ where: { id } });
    if (!r.count) throw new NotFoundException('Provider not found');
    this.cache.delete(id);
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'SSO_PROVIDER_CHANGED', resource: 'oidc_provider', resourceId: id, meta: { op: 'delete' } });
    return { deleted: true };
  }

  async addMapping(actor: ActorContext, providerId: string, dto: { groupValue: string; businessId: string; capabilities?: string[] }) {
    this.assertAdmin(actor);
    if (!(await this.prisma.oidcProvider.findUnique({ where: { id: providerId } }))) throw new NotFoundException('Provider not found');
    const biz = await this.prisma.customer.findUnique({ where: { id: dto.businessId }, select: { id: true } });
    if (!biz) throw new NotFoundException('Business not found');
    const value = dto.groupValue?.trim();
    if (!value || value.length > 256) throw new BadRequestException('groupValue is required');
    const m = await this.prisma.oidcGroupMapping.create({
      data: { providerId, groupValue: value, customerId: biz.id, capabilities: sanitizeCapabilities(dto.capabilities ?? []) },
    }).catch((e: { code?: string }) => {
      if (e.code === 'P2002') throw new ConflictException('That group is already mapped');
      throw e;
    });
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'SSO_PROVIDER_CHANGED', resource: 'oidc_provider', resourceId: providerId, meta: { op: 'map_group', group: value, businessId: biz.id, capabilities: m.capabilities } });
    return m;
  }

  async removeMapping(actor: ActorContext, providerId: string, mappingId: string) {
    this.assertAdmin(actor);
    const r = await this.prisma.oidcGroupMapping.deleteMany({ where: { id: mappingId, providerId } });
    if (!r.count) throw new NotFoundException('Mapping not found');
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'SSO_PROVIDER_CHANGED', resource: 'oidc_provider', resourceId: providerId, meta: { op: 'unmap_group', mappingId } });
    return { deleted: true };
  }

  /** Fetch discovery and report what the provider says, without signing anyone in. */
  async testProvider(actor: ActorContext, id: string) {
    this.assertAdmin(actor);
    const p = await this.prisma.oidcProvider.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Provider not found');
    this.cache.delete(id);
    try {
      const cfg = await this.configuration(p);
      const m = cfg.serverMetadata();
      return {
        ok: true, issuer: m.issuer, authorizationEndpoint: m.authorization_endpoint, tokenEndpoint: m.token_endpoint,
        pkce: (m.code_challenge_methods_supported ?? []).includes('S256'),
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 300) };
    }
  }

  private async configuration(p: OidcProvider): Promise<oidc.Configuration> {
    const stamp = p.updatedAt.getTime();
    const hit = this.cache.get(p.id);
    if (hit && hit.stamp === stamp && Date.now() - hit.at < 60 * 60_000) return hit.cfg;
    const issuer = this.checkUrl('Issuer', p.issuer);
    const secret = p.clientSecretEnc ? this.dec(p.clientSecretEnc) : undefined;
    const cfg = await oidc.discovery(
      issuer, p.clientId, undefined,
      secret ? oidc.ClientSecretPost(secret) : oidc.None(),
      { execute: this.insecureAllowed(issuer) ? [oidc.allowInsecureRequests] : [], timeout: 10 },
    );
    this.cache.set(p.id, { stamp, at: Date.now(), cfg });
    return cfg;
  }

  // ── Sign-in round trip ─────────────────────────────────────────────────

  async enabledProviders() {
    const rows = await this.prisma.oidcProvider.findMany({ where: { enabled: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return rows;
  }

  /** Begin a round trip. Returns the provider URL and the state to bind to this browser. */
  async start(providerId: string, purpose: 'LOGIN' | 'LINK', opts: { userId?: string; returnTo?: string }) {
    const p = await this.prisma.oidcProvider.findUnique({ where: { id: providerId } });
    if (!p || !p.enabled) throw new NotFoundException('Sign-in provider not available');
    const cfg = await this.configuration(p);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    await this.prisma.oidcLoginState.create({
      data: {
        stateHash: sha(state), providerId: p.id, nonce, codeVerifier, purpose,
        userId: purpose === 'LINK' ? opts.userId ?? null : null,
        returnTo: safeReturnTo(opts.returnTo), expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: p.redirectUri, scope: p.scopes, state, nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256',
    });
    return { url: url.href, state };
  }

  /**
   * Finish a round trip. `query` is the callback's query string as received;
   * `cookieState` is the state this browser was given at the start.
   */
  async callback(query: Record<string, string>, cookieState: string | undefined, ip: string, userAgent: string) {
    const state = query.state;
    if (!state || !cookieState || state.length !== cookieState.length || state !== cookieState) {
      throw new SsoError('state_mismatch', 'The sign-in did not start in this browser, or has expired.');
    }
    const row = await this.prisma.oidcLoginState.findUnique({ where: { stateHash: sha(state) } });
    // Single use: only the request that deletes the row may continue.
    const consumed = row ? await this.prisma.oidcLoginState.deleteMany({ where: { id: row.id, expiresAt: { gt: new Date() } } }) : { count: 0 };
    if (!row || consumed.count !== 1) throw new SsoError('expired', 'This sign-in link has expired. Start again.');

    try {
      return await this.finish(row, query, state, ip, userAgent);
    } catch (e) {
      if (row.purpose === 'LINK') {
        const err = e instanceof SsoError ? e : new SsoError('failed');
        err.linkFlow = true;
        throw err;
      }
      throw e;
    }
  }

  private async finish(
    row: { providerId: string; codeVerifier: string; nonce: string; purpose: string; userId: string | null; returnTo: string | null },
    query: Record<string, string>, state: string, ip: string, userAgent: string,
  ) {
    const p = await this.prisma.oidcProvider.findUnique({ where: { id: row.providerId } });
    if (!p || !p.enabled) throw new SsoError('disabled', 'That sign-in provider is not available.');
    if (query.error) {
      await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'provider_error', error: String(query.error).slice(0, 64) } });
      throw new SsoError('provider_error', 'The provider did not complete the sign-in.');
    }

    const cfg = await this.configuration(p);
    const current = new URL(p.redirectUri);
    for (const [k, v] of Object.entries(query)) current.searchParams.set(k, v);
    let claims: oidc.IDToken | undefined;
    try {
      const tokens = await oidc.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: row.codeVerifier, expectedState: state, expectedNonce: row.nonce, idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (e) {
      this.logger.warn(`OIDC code exchange failed for provider ${p.id}: ${(e as Error).message}`);
      await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'exchange_failed' } });
      throw new SsoError('exchange_failed', 'The provider\'s response could not be verified.');
    }
    if (!claims?.sub || claims.iss !== p.issuer) {
      await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'issuer_mismatch' } });
      throw new SsoError('exchange_failed', 'The provider\'s response could not be verified.');
    }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase().slice(0, 254) : null;

    if (row.purpose === 'LINK') return this.finishLink(p, row.userId, claims.sub, email, ip, row.returnTo);
    return this.finishLogin(p, claims, email, ip, userAgent, row.returnTo);
  }

  private async finishLink(p: OidcProvider, userId: string | null, subject: string, email: string | null, ip: string, returnTo: string | null) {
    if (!userId) throw new SsoError('expired');
    const existing = await this.prisma.externalIdentity.findUnique({ where: { issuer_subject: { issuer: p.issuer, subject } } });
    if (existing && existing.userId !== userId) {
      await this.audit.log({ actorId: userId, actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'linked_elsewhere' } });
      throw new SsoError('linked_elsewhere', 'That identity is already linked to another account.');
    }
    if (!existing) {
      const mine = await this.prisma.externalIdentity.count({ where: { userId, providerId: p.id } });
      if (mine) throw new SsoError('already_linked', 'Your account is already linked to a different identity at this provider. Unlink it first.');
      await this.prisma.externalIdentity.create({ data: { userId, providerId: p.id, issuer: p.issuer, subject, email } });
      await this.audit.log({ actorId: userId, actorIp: ip, action: 'SSO_LINKED', resource: 'oidc_provider', resourceId: p.id });
    }
    return { kind: 'linked' as const, returnTo: returnTo ?? '/account' };
  }

  private async finishLogin(p: OidcProvider, claims: oidc.IDToken, email: string | null, ip: string, userAgent: string, returnTo: string | null) {
    const subject = claims.sub;
    let identity = await this.prisma.externalIdentity.findUnique({ where: { issuer_subject: { issuer: p.issuer, subject } } });
    if (!identity) {
      if (!p.allowProvisioning) {
        await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'not_linked' } });
        throw new SsoError('not_linked', 'No account is linked to that identity. Sign in with your password and link it from your account page.');
      }
      if (!email || claims.email_verified !== true) {
        await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'email_unverified' } });
        throw new SsoError('email_unverified', 'The provider did not supply a verified email address.');
      }
      if (await this.prisma.user.findUnique({ where: { email } })) {
        // Never link by email — see the class comment.
        await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'email_in_use' } });
        throw new SsoError('email_in_use', 'An account with that email already exists. Sign in with your password and link this provider from your account page.');
      }
      identity = await this.provision(p, claims, email);
      if (!identity) {
        throw new SsoError('provisioned_no_access', 'Your account was created, but it has no access yet. Ask an administrator to add you to a business.');
      }
    }
    await this.prisma.externalIdentity.update({ where: { id: identity.id }, data: { lastLoginAt: new Date(), email } });
    const result = await this.auth.signInVerifiedUser(identity.userId, ip, userAgent, 'sso', false)
      .catch(async (e: Error) => {
        await this.audit.log({ actorId: identity!.userId, actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'account', detail: e.message.slice(0, 120) } });
        throw new SsoError('account', e.message);
      });
    await this.audit.log({ actorId: identity.userId, actorIp: ip, actorAgent: userAgent, action: 'SSO_LOGIN', resource: 'oidc_provider', resourceId: p.id, meta: { mfaPending: !!result.requiresMfa } });
    return { kind: 'session' as const, result, returnTo: returnTo ?? '/dashboard' };
  }

  /**
   * A new account for a provisioning provider. Returns the identity when the
   * account can sign in (a group mapping gave it a membership), else null:
   * the account and identity still exist, so an administrator can add the
   * person to a business and their next SSO sign-in works.
   */
  private async provision(p: OidcProvider, claims: oidc.IDToken, email: string) {
    const groupsRaw = p.groupsClaim ? (claims as Record<string, unknown>)[p.groupsClaim] : undefined;
    const groups = Array.isArray(groupsRaw) ? groupsRaw.filter((g): g is string => typeof g === 'string') : [];
    const mapping = groups.length
      ? await this.prisma.oidcGroupMapping.findFirst({ where: { providerId: p.id, groupValue: { in: groups } }, orderBy: { createdAt: 'asc' } })
      : null;
    const str = (k: string) => (typeof (claims as Record<string, unknown>)[k] === 'string' ? String((claims as Record<string, unknown>)[k]).slice(0, 80) : null);

    const out = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email, status: 'ACTIVE', firstName: str('given_name') ?? '', lastName: str('family_name') ?? '',
          // No usable password: SSO (or a passkey added later) is how this
          // account signs in, until someone sets one through a reset.
          passwordHash: `!sso-only:${randomBytes(16).toString('hex')}`,
        },
      });
      const identity = await tx.externalIdentity.create({ data: { userId: user.id, providerId: p.id, issuer: p.issuer, subject: claims.sub, email } });
      let membership = false;
      if (mapping) {
        const biz = await tx.customer.findUnique({ where: { id: mapping.customerId }, select: { id: true, tenantId: true } });
        const role = biz ? await tx.role.findFirst({ where: { tenantId: biz.tenantId, type: 'BUSINESS_USER' } }) : null;
        if (biz && role) {
          await tx.membership.create({
            data: { userId: user.id, tenantId: biz.tenantId, customerId: biz.id, roleId: role.id, capabilities: sanitizeCapabilities(mapping.capabilities), isActive: true },
          });
          membership = true;
        }
      }
      return { identity, membership, userId: user.id, businessId: mapping?.customerId ?? null };
    });
    await this.audit.log({
      actorId: out.userId, customerId: out.businessId ?? undefined, action: 'SSO_LINKED', resource: 'oidc_provider', resourceId: p.id,
      meta: { provisioned: true, group: mapping?.groupValue ?? null, membership: out.membership },
    });
    return out.membership ? out.identity : null;
  }

  // ── The signed-in user's own identities ────────────────────────────────

  async myIdentities(userId: string) {
    const rows = await this.prisma.externalIdentity.findMany({
      where: { userId }, select: { id: true, email: true, linkedAt: true, lastLoginAt: true, provider: { select: { id: true, name: true, enabled: true } } },
      orderBy: { linkedAt: 'asc' },
    });
    return rows;
  }

  async unlink(userId: string, identityId: string, ip?: string) {
    const r = await this.prisma.externalIdentity.findFirst({ where: { id: identityId, userId } });
    if (!r) throw new NotFoundException('Linked identity not found');
    await this.prisma.externalIdentity.delete({ where: { id: r.id } });
    await this.audit.log({ actorId: userId, actorIp: ip, action: 'SSO_UNLINKED', resource: 'oidc_provider', resourceId: r.providerId });
    return { deleted: true };
  }
}
