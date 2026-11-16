import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
  OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, generateKeyPairSync, randomBytes, webcrypto } from 'crypto';
import * as oidc from 'openid-client';
import type { OidcProvider, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { ActorContext } from '../rbac/access-control.service';
import { sanitizeCapabilities } from '../rbac/capabilities';
import { safeReturnTo } from '../auth/cookies';
import { PublicUrlService } from '../platform/public-url.service';
import { isRevoked } from '../auth/session-revocation';
import { openSecret, sealSecret } from '../common/secret-box';
import {
  ACR_RE, ORG_ID_RE, amrList, assessLevel, idpMfaSatisfies, orgClaimMatches, platformAdminDecision, stepUpDecision,
  type AcrLevels, type Level,
} from './identity-policy';

const STATE_TTL_MS = 10 * 60_000;
/** An SSO session lives as long as the Rem0te session it produced (setAccessCookie: 8 h). */
export const SSO_SESSION_TTL_MS = 8 * 60 * 60_000;
/** Pending link suggestions kept at once; past this, new ones are not recorded. */
export const MAX_PENDING_SUGGESTIONS = 500;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** A refusal the callback turns into a redirect with `?sso_error=<code>`. Never carries provider detail. */
export class SsoError extends Error {
  /** Set when the failed round trip was a signed-in user linking: send them back to their account, not to sign-in. */
  linkFlow = false;
  /** Set when it was a step-up: send them back where they were. */
  stepUpReturnTo: string | null = null;
  constructor(public readonly code: string, detail?: string) { super(detail ?? code); }
}

export interface ProviderInput {
  name?: string; issuer?: string; clientId?: string; clientSecret?: string | null;
  redirectUri?: string; scopes?: string; enabled?: boolean; allowProvisioning?: boolean; groupsClaim?: string | null;
  // 0.59
  tokenAuth?: string; bindOrgId?: string | null;
  acrPassword?: string | null; acrMfa?: string | null; acrPasskey?: string | null;
  trustIdpMfa?: boolean; trustIdpPasskey?: boolean; allowPlatformAdmin?: boolean;
  sessionCheckFailMode?: string; postLogoutRedirectUri?: string | null;
}

type LoginRow = {
  id?: string; providerId: string; codeVerifier: string; nonce: string; purpose: string; userId: string | null; returnTo: string | null;
  requiredLevel: string | null; sessionIat: number | null; createdAt: Date;
};

/**
 * OpenID Connect sign-in (authorization code + PKCE, via openid-client).
 *
 * Account matching is by (issuer, subject) and nothing else. An email address
 * from the provider is never used to find or link an account: someone who
 * controls an IdP, or an IdP that lets users set their own email, could
 * otherwise take over any account by naming its address. (0.59: a verified
 * email match is recorded as a *suggestion* a Platform Admin may confirm, one
 * at a time — never acted on by itself.)
 *
 * So an identity reaches an account one of three ways:
 *   linked       a signed-in user (after step-up) starts a LINK round trip
 *                and the identity that comes back is attached to them;
 *   confirmed    a Platform Admin confirms one link suggestion (0.59);
 *   provisioned  only if the provider allows it, a NEW account with a
 *                verified email no other account has — with no business and
 *                no permissions unless an explicit group mapping grants one.
 *
 * The rest of sign-in is the password path's: account status, the lockout,
 * and TOTP when the account has it or the tenant requires it — unless the
 * provider is trusted for MFA and its acr and amr say it did MFA (0.59). A
 * Platform Admin cannot sign in through SSO unless the provider allows it,
 * and then only at the passkey level (0.59). Claims are gates, never grants.
 * dist/cli/auth-recovery.js (src/cli/auth-recovery.ts) disables every
 * provider, and lowers any `required` sign-in mode, from the host.
 */
@Injectable()
export class SsoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SsoService.name);
  private readonly key: Buffer;
  private readonly encKey: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cache = new Map<string, { stamp: number; at: number; cfg: oidc.Configuration }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly urls: PublicUrlService,
  ) {
    this.encKey = this.config.get<string>('ENCRYPTION_KEY');
    this.key = Buffer.from(this.encKey ?? '', 'hex');
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
  insecureAllowed(u: URL) {
    return this.config.get<string>('OIDC_ALLOW_INSECURE_LOOPBACK') === 'true' && this.isLoopback(u);
  }
  checkUrl(label: string, v: string): URL {
    let u: URL;
    try { u = new URL(v); } catch { throw new BadRequestException(`${label} is not a URL`); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.insecureAllowed(u))) {
      throw new BadRequestException(`${label} must use https://`);
    }
    if (u.username || u.password || u.hash) throw new BadRequestException(`${label} must not contain credentials or a fragment`);
    return u;
  }

  levels(p: Pick<OidcProvider, 'acrPassword' | 'acrMfa' | 'acrPasskey'>): AcrLevels {
    return { password: p.acrPassword ?? null, mfa: p.acrMfa ?? null, passkey: p.acrPasskey ?? null };
  }

  /** Where Rem0te's own endpoints for this provider are, to register at the provider. */
  endpoints(id: string) {
    const api = this.urls.web();
    return {
      backchannelLogoutUri: `${api}/api/v1/auth/sso/backchannel-logout`,
      jwksUri: `${api}/api/v1/auth/sso/${id}/jwks.json`,
      defaultPostLogoutRedirectUri: `${this.urls.web()}/login?signed_out=1`,
    };
  }

  private view(p: OidcProvider & { groupMappings?: { id: string; groupValue: string; customerId: string; capabilities: string[] }[]; _count?: { identities: number } }) {
    return {
      id: p.id, name: p.name, issuer: p.issuer, clientId: p.clientId, hasClientSecret: !!p.clientSecretEnc,
      redirectUri: p.redirectUri, scopes: p.scopes, enabled: p.enabled, allowProvisioning: p.allowProvisioning,
      groupsClaim: p.groupsClaim, groupMappings: p.groupMappings ?? [], linkedAccounts: p._count?.identities ?? 0,
      // 0.59. The private key is never in a view; only whether there is one and its public half.
      tokenAuth: p.tokenAuth, hasClientKey: !!p.clientKeyEnc, clientKeyKid: p.clientKeyKid, clientPublicJwk: p.clientPublicJwk ?? null,
      bindOrgId: p.bindOrgId, acrLevels: this.levels(p),
      trustIdpMfa: p.trustIdpMfa, trustIdpPasskey: p.trustIdpPasskey, allowPlatformAdmin: p.allowPlatformAdmin,
      sessionCheckFailMode: p.sessionCheckFailMode, postLogoutRedirectUri: p.postLogoutRedirectUri,
      ...this.endpoints(p.id),
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

  /**
   * The 0.59 settings, checked. Everything defaults off: a setting that
   * trusts the provider more needs the acr value it would trust named first.
   */
  private settings(dto: ProviderInput, cur: Partial<OidcProvider> | null): Prisma.OidcProviderUpdateInput {
    const out: Prisma.OidcProviderUpdateInput = {};
    const acr = (label: string, v: string | null | undefined) => {
      if (v === undefined) return undefined;
      if (v === null || v.trim() === '') return null;
      if (!ACR_RE.test(v.trim())) throw new BadRequestException(`${label} must be 1–128 printable characters with no spaces`);
      return v.trim();
    };
    const a1 = acr('The password acr value', dto.acrPassword); if (a1 !== undefined) out.acrPassword = a1;
    const a2 = acr('The MFA acr value', dto.acrMfa); if (a2 !== undefined) out.acrMfa = a2;
    const a3 = acr('The passkey acr value', dto.acrPasskey); if (a3 !== undefined) out.acrPasskey = a3;
    const next = {
      acrMfa: a2 !== undefined ? a2 : cur?.acrMfa ?? null,
      acrPasskey: a3 !== undefined ? a3 : cur?.acrPasskey ?? null,
      acrPassword: a1 !== undefined ? a1 : cur?.acrPassword ?? null,
    };
    const vals = [next.acrPassword, next.acrMfa, next.acrPasskey].filter((x): x is string => !!x);
    if (new Set(vals).size !== vals.length) throw new BadRequestException('Each level needs its own acr value');
    if (dto.bindOrgId !== undefined) {
      const v = dto.bindOrgId?.trim() || null;
      if (v && !ORG_ID_RE.test(v)) throw new BadRequestException('The organization id must be 1–128 letters, digits, dots, colons, dashes or underscores');
      out.bindOrgId = v;
    }
    if (dto.tokenAuth !== undefined) {
      if (dto.tokenAuth !== 'client_secret_post' && dto.tokenAuth !== 'private_key_jwt') throw new BadRequestException('tokenAuth must be client_secret_post or private_key_jwt');
      if (dto.tokenAuth === 'private_key_jwt' && !cur?.clientKeyEnc) throw new BadRequestException('Generate a client key first, and register its public key at the provider.');
      out.tokenAuth = dto.tokenAuth;
    }
    if (dto.trustIdpMfa !== undefined) {
      if (dto.trustIdpMfa === true && !next.acrMfa) throw new BadRequestException('Name the provider\'s MFA acr value before trusting its MFA');
      out.trustIdpMfa = dto.trustIdpMfa === true;
    } else if (cur?.trustIdpMfa && !next.acrMfa) out.trustIdpMfa = false;
    if (dto.trustIdpPasskey !== undefined) {
      if (dto.trustIdpPasskey === true && !next.acrPasskey) throw new BadRequestException('Name the provider\'s passkey acr value before trusting its passkeys');
      out.trustIdpPasskey = dto.trustIdpPasskey === true;
    } else if (cur?.trustIdpPasskey && !next.acrPasskey) out.trustIdpPasskey = false;
    if (dto.allowPlatformAdmin !== undefined) {
      if (dto.allowPlatformAdmin === true && !next.acrPasskey) throw new BadRequestException('A Platform Admin may sign in through SSO only at the passkey level: name the passkey acr value first');
      out.allowPlatformAdmin = dto.allowPlatformAdmin === true;
    } else if (cur?.allowPlatformAdmin && !next.acrPasskey) out.allowPlatformAdmin = false;
    if (dto.sessionCheckFailMode !== undefined) {
      if (dto.sessionCheckFailMode !== 'open' && dto.sessionCheckFailMode !== 'closed') throw new BadRequestException('sessionCheckFailMode must be open or closed');
      out.sessionCheckFailMode = dto.sessionCheckFailMode;
    }
    if (dto.postLogoutRedirectUri !== undefined) {
      const v = dto.postLogoutRedirectUri?.trim() || null;
      if (v) this.checkUrl('Post-logout redirect URI', v);
      out.postLogoutRedirectUri = v;
    }
    return out;
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
    // A new provider has no key yet, so it cannot start as private_key_jwt.
    const extra = this.settings({ ...dto, tokenAuth: undefined }, null) as Prisma.OidcProviderCreateInput;
    const p = await this.prisma.oidcProvider.create({
      data: {
        ...extra,
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
    const extra = this.settings(dto, cur);
    const p = await this.prisma.oidcProvider.update({
      where: { id },
      data: {
        ...extra,
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

  /**
   * Generate (or replace) the provider's private_key_jwt key: P-256, ES256.
   * The private key is sealed and never leaves the server; the public JWK is
   * returned to register at the provider (or fetched from jwksUri).
   */
  async generateClientKey(actor: ActorContext, id: string) {
    this.assertAdmin(actor);
    const cur = await this.prisma.oidcProvider.findUnique({ where: { id } });
    if (!cur) throw new NotFoundException('Provider not found');
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
    // RFC 7638 thumbprint as the kid.
    const kid = createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest('base64url');
    const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid, use: 'sig', alg: 'ES256' };
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const p = await this.prisma.oidcProvider.update({
      where: { id },
      data: { clientKeyEnc: sealSecret(this.encKey, 'rem0te-oidc-client-key-v1', pem), clientKeyKid: kid, clientPublicJwk: publicJwk },
    });
    this.cache.delete(id);
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action: 'SSO_PROVIDER_CHANGED', resource: 'oidc_provider', resourceId: id, meta: { op: 'client_key', kid, replaced: !!cur.clientKeyEnc } });
    return this.view(p);
  }

  /** The provider's public client key set, for the provider to fetch. Public keys only. */
  async publicJwks(id: string) {
    const p = await this.prisma.oidcProvider.findUnique({ where: { id }, select: { clientPublicJwk: true } });
    return { keys: p?.clientPublicJwk ? [p.clientPublicJwk] : [] };
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
        // 0.59: what the identity work needs from the provider.
        endSession: !!m.end_session_endpoint,
        backchannelLogout: (m as Record<string, unknown>).backchannel_logout_supported === true,
        privateKeyJwt: (m.token_endpoint_auth_methods_supported ?? []).includes('private_key_jwt'),
        acrValues: Array.isArray(m.acr_values_supported) ? m.acr_values_supported.slice(0, 20) : [],
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message.slice(0, 300) };
    }
  }

  private async clientAuth(p: OidcProvider): Promise<oidc.ClientAuth> {
    if (p.tokenAuth === 'private_key_jwt') {
      if (!p.clientKeyEnc || !p.clientKeyKid) throw new Error('private_key_jwt without a client key');
      const pem = openSecret(this.encKey, 'rem0te-oidc-client-key-v1', p.clientKeyEnc);
      const der = createPrivateKey(pem).export({ format: 'der', type: 'pkcs8' });
      const key = await webcrypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      return oidc.PrivateKeyJwt({ key: key as unknown as oidc.CryptoKey, kid: p.clientKeyKid });
    }
    const secret = p.clientSecretEnc ? this.dec(p.clientSecretEnc) : undefined;
    return secret ? oidc.ClientSecretPost(secret) : oidc.None();
  }

  async configuration(p: OidcProvider): Promise<oidc.Configuration> {
    const stamp = p.updatedAt.getTime();
    const hit = this.cache.get(p.id);
    if (hit && hit.stamp === stamp && Date.now() - hit.at < 60 * 60_000) return hit.cfg;
    const issuer = this.checkUrl('Issuer', p.issuer);
    const cfg = await oidc.discovery(
      issuer, p.clientId, undefined,
      await this.clientAuth(p),
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
  async start(providerId: string, purpose: 'LOGIN' | 'LINK' | 'STEP_UP', opts: {
    userId?: string; returnTo?: string; requiredLevel?: 'mfa' | 'passkey'; sessionIat?: number;
  }) {
    const p = await this.prisma.oidcProvider.findUnique({ where: { id: providerId } });
    if (!p || !p.enabled) throw new NotFoundException('Sign-in provider not available');
    const cfg = await this.configuration(p);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const stepUp = purpose === 'STEP_UP';
    const acrValues = stepUp ? (opts.requiredLevel === 'passkey' ? p.acrPasskey : p.acrMfa) : null;
    if (stepUp && (!opts.userId || !opts.requiredLevel || opts.sessionIat === undefined || !acrValues)) {
      throw new ConflictException({ code: 'SSO_STEP_UP_UNAVAILABLE', message: 'This provider is not set up to confirm it is you at that level.' });
    }
    await this.prisma.oidcLoginState.create({
      data: {
        stateHash: sha(state), providerId: p.id, nonce, codeVerifier, purpose,
        userId: purpose === 'LOGIN' ? null : opts.userId ?? null,
        returnTo: safeReturnTo(opts.returnTo), expiresAt: new Date(Date.now() + STATE_TTL_MS),
        requiredLevel: stepUp ? opts.requiredLevel : null, sessionIat: stepUp ? opts.sessionIat : null,
      },
    });
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: p.redirectUri, scope: p.scopes, state, nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: 'S256',
      // 0.59 step-up: authenticate again now (max_age=0, prompt=login), at
      // the level asked for (acr_values). The callback checks it happened.
      ...(stepUp ? { max_age: '0', prompt: 'login', acr_values: acrValues! } : {}),
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
      const err = e instanceof SsoError ? e : new SsoError('failed');
      if (!(e instanceof SsoError)) this.logger.warn(`SSO callback failed: ${(e as Error).message}`);
      if (row.purpose === 'LINK') err.linkFlow = true;
      if (row.purpose === 'STEP_UP') err.stepUpReturnTo = row.returnTo ?? '/dashboard';
      throw err;
    }
  }

  private async finish(row: LoginRow, query: Record<string, string>, state: string, ip: string, userAgent: string) {
    const p = await this.prisma.oidcProvider.findUnique({ where: { id: row.providerId } });
    if (!p || !p.enabled) throw new SsoError('disabled', 'That sign-in provider is not available.');
    if (query.error) {
      await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'provider_error', error: String(query.error).slice(0, 64), purpose: row.purpose } });
      throw new SsoError('provider_error', 'The provider did not complete the sign-in.');
    }

    const cfg = await this.configuration(p);
    const current = new URL(p.redirectUri);
    for (const [k, v] of Object.entries(query)) current.searchParams.set(k, v);
    let claims: oidc.IDToken | undefined;
    let refreshToken: string | null;
    let idToken: string | null;
    try {
      const tokens = await oidc.authorizationCodeGrant(cfg, current, {
        pkceCodeVerifier: row.codeVerifier, expectedState: state, expectedNonce: row.nonce, idTokenExpected: true,
      });
      claims = tokens.claims();
      refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null;
      idToken = typeof tokens.id_token === 'string' ? tokens.id_token : null;
    } catch (e) {
      this.logger.warn(`OIDC code exchange failed for provider ${p.id}: ${(e as Error).message}`);
      await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'exchange_failed', purpose: row.purpose } });
      throw new SsoError('exchange_failed', 'The provider\'s response could not be verified.');
    }
    if (!claims?.sub || claims.iss !== p.issuer) {
      await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'issuer_mismatch' } });
      throw new SsoError('exchange_failed', 'The provider\'s response could not be verified.');
    }
    const c = claims as Record<string, unknown>;
    // auth_time, when present, is a number and not in the future.
    if (c.auth_time !== undefined && (typeof c.auth_time !== 'number' || c.auth_time > Math.floor(Date.now() / 1000) + 60)) {
      await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'auth_time_invalid' } });
      throw new SsoError('exchange_failed', 'The provider\'s response could not be verified.');
    }
    // 0.59: the organization gate, for every purpose. A gate, never a grant.
    if (p.bindOrgId && !orgClaimMatches(c.organization, p.bindOrgId)) {
      await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'org_mismatch', purpose: row.purpose } });
      throw new SsoError('org_mismatch', 'That identity does not belong to the organization this provider is bound to.');
    }
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase().slice(0, 254) : null;

    if (row.purpose === 'LINK') return this.finishLink(p, row.userId, claims.sub, email, ip, row.returnTo);
    if (row.purpose === 'STEP_UP') return this.finishStepUp(p, row, claims, ip);
    return this.finishLogin(p, claims, email, ip, userAgent, row.returnTo, { refreshToken, idToken });
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
      await this.prisma.ssoLinkSuggestion.updateMany({ where: { userId, providerId: p.id, status: 'PENDING' }, data: { status: 'LINKED', decidedById: userId, decidedAt: new Date() } });
      await this.audit.log({ actorId: userId, actorIp: ip, action: 'SSO_LINKED', resource: 'oidc_provider', resourceId: p.id, meta: { by: 'self' } });
    }
    return { kind: 'linked' as const, returnTo: returnTo ?? '/account' };
  }

  /**
   * 0.59: confirm it is you through the provider. The identity that comes
   * back must be the one linked to this account; it must have authenticated
   * after the round trip began; and the level it proved, corroborated by
   * amr, must meet the one asked for.
   */
  private async finishStepUp(p: OidcProvider, row: LoginRow, claims: oidc.IDToken, ip: string) {
    const c = claims as Record<string, unknown>;
    const identity = await this.prisma.externalIdentity.findUnique({ where: { issuer_subject: { issuer: p.issuer, subject: claims.sub } }, select: { userId: true } });
    const level = assessLevel(this.levels(p), c.acr, c.amr);
    const d = stepUpDecision({
      linkedUserId: identity?.userId ?? null, expectedUserId: row.userId ?? '', authTime: c.auth_time,
      startedAt: row.createdAt.getTime(), level, need: row.requiredLevel === 'passkey' ? 'passkey' : 'mfa', trustIdpPasskey: p.trustIdpPasskey,
    });
    if (!d.ok) {
      await this.audit.log({ actorId: row.userId ?? undefined, actorIp: ip, action: 'STEP_UP_FAILED', resource: 'oidc_provider', resourceId: p.id, meta: { method: 'sso', reason: d.code, level } });
      throw new SsoError(d.code);
    }
    const u = await this.prisma.user.findUnique({ where: { id: row.userId! }, select: { status: true, sessionsValidAfter: true } });
    if (!u || u.status !== 'ACTIVE' || isRevoked(row.sessionIat ?? 0, u.sessionsValidAfter)) throw new SsoError('step_up_session_ended');
    await this.audit.log({ actorId: row.userId!, actorIp: ip, action: 'STEP_UP_VERIFIED', resource: 'oidc_provider', resourceId: p.id, meta: { method: d.method, level } });
    return { kind: 'step_up' as const, userId: row.userId!, sessionIat: row.sessionIat ?? 0, method: d.method, returnTo: row.returnTo ?? '/dashboard' };
  }

  /**
   * Record that an unlinked identity's verified email matches a local
   * account, for a Platform Admin to confirm or dismiss. Never a Platform
   * Admin or break-glass account (those link themselves, after step-up), and
   * never acted on here.
   */
  private async suggest(p: OidcProvider, subject: string, email: string | null, verified: boolean) {
    if (!email || !verified) return;
    const u = await this.prisma.user.findUnique({ where: { email }, select: { id: true, status: true, isPlatformAdmin: true, breakGlass: true } });
    if (!u || u.status !== 'ACTIVE' || u.isPlatformAdmin || u.breakGlass) return;
    if (await this.prisma.externalIdentity.count({ where: { userId: u.id, providerId: p.id } })) return;
    const existing = await this.prisma.ssoLinkSuggestion.findUnique({ where: { issuer_subject_userId: { issuer: p.issuer, subject, userId: u.id } } });
    if (existing) {
      if (existing.status === 'PENDING') await this.prisma.ssoLinkSuggestion.update({ where: { id: existing.id }, data: { lastSeenAt: new Date(), email } });
      return;
    }
    if ((await this.prisma.ssoLinkSuggestion.count({ where: { status: 'PENDING' } })) >= MAX_PENDING_SUGGESTIONS) return;
    await this.prisma.ssoLinkSuggestion.create({ data: { providerId: p.id, issuer: p.issuer, subject, email, userId: u.id } }).catch(() => undefined);
  }

  private async finishLogin(
    p: OidcProvider, claims: oidc.IDToken, email: string | null, ip: string, userAgent: string, returnTo: string | null,
    tokens: { refreshToken: string | null; idToken: string | null },
  ) {
    const subject = claims.sub;
    const c = claims as Record<string, unknown>;
    let identity = await this.prisma.externalIdentity.findUnique({ where: { issuer_subject: { issuer: p.issuer, subject } } });
    if (!identity) {
      if (!p.allowProvisioning) {
        await this.suggest(p, subject, email, claims.email_verified === true);
        await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'not_linked' } });
        throw new SsoError('not_linked', 'No account is linked to that identity. Sign in with your password and link it from your account page.');
      }
      if (!email || claims.email_verified !== true) {
        await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'email_unverified' } });
        throw new SsoError('email_unverified', 'The provider did not supply a verified email address.');
      }
      if (await this.prisma.user.findUnique({ where: { email } })) {
        // Never link by email — see the class comment.
        await this.suggest(p, subject, email, true);
        await this.audit.log({ actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'email_in_use' } });
        throw new SsoError('email_in_use', 'An account with that email already exists. Sign in with your password and link this provider from your account page.');
      }
      identity = await this.provision(p, claims, email);
      if (!identity) {
        throw new SsoError('provisioned_no_access', 'Your account was created, but it has no access yet. Ask an administrator to add you to a business.');
      }
    }

    // 0.59: what the provider proved, believed only as far as amr corroborates it.
    const amr = amrList(c.amr);
    const acr = typeof c.acr === 'string' ? c.acr.slice(0, 128) : null;
    const sid = typeof c.sid === 'string' ? c.sid.slice(0, 256) : null;
    const level: Level = assessLevel(this.levels(p), acr, amr);
    const who = await this.prisma.user.findUnique({ where: { id: identity.userId }, select: { isPlatformAdmin: true } });
    if (who?.isPlatformAdmin) {
      const d = platformAdminDecision(p, level);
      if (!d.ok) {
        await this.audit.log({ actorId: identity.userId, actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: d.code, level } });
        throw new SsoError(d.code, d.code === 'admin_not_allowed'
          ? 'A Platform Admin cannot sign in through this provider.'
          : 'A Platform Admin can sign in through this provider only with a passkey at the provider.');
      }
    }
    const mfaSatisfied = idpMfaSatisfies(p, level);

    await this.prisma.externalIdentity.update({ where: { id: identity.id }, data: { lastLoginAt: new Date(), email } });
    const sso = await this.prisma.ssoSession.create({
      data: {
        userId: identity.userId, providerId: p.id, subject, sid, acr, amr, level,
        authTime: typeof c.auth_time === 'number' ? new Date(c.auth_time * 1000) : null,
        refreshTokenEnc: tokens.refreshToken ? sealSecret(this.encKey, 'rem0te-oidc-refresh-v1', tokens.refreshToken) : null,
        idTokenEnc: tokens.idToken ? sealSecret(this.encKey, 'rem0te-oidc-id-token-v1', tokens.idToken) : null,
        expiresAt: new Date(Date.now() + SSO_SESSION_TTL_MS),
      },
      select: { id: true },
    });
    const userId = identity.userId;
    const result = await this.auth.signInVerifiedUser(userId, ip, userAgent, 'sso', mfaSatisfied, { ssoSessionId: sso.id })
      .catch(async (e: Error) => {
        await this.prisma.ssoSession.deleteMany({ where: { id: sso.id } });
        await this.audit.log({ actorId: userId, actorIp: ip, action: 'SSO_LOGIN_DENIED', resource: 'oidc_provider', resourceId: p.id, meta: { reason: 'account', detail: e.message.slice(0, 120) } });
        throw new SsoError('account', e.message);
      });
    await this.audit.log({
      actorId: userId, actorIp: ip, actorAgent: userAgent, action: 'SSO_LOGIN', resource: 'oidc_provider', resourceId: p.id,
      meta: { mfaPending: !!result.requiresMfa, level, idpMfa: mfaSatisfied, sid: !!sid, refresh: !!tokens.refreshToken },
    });
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

  // ── Step-up through the provider (0.59) ────────────────────────────────

  /** What the step-up dialog may offer this account through SSO. */
  async stepUpOptions(userId: string) {
    const [ids, u] = await Promise.all([
      this.prisma.externalIdentity.findMany({
        where: { userId, provider: { enabled: true } },
        select: { provider: { select: { id: true, name: true, acrMfa: true, acrPasskey: true, trustIdpPasskey: true } } },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }),
    ]);
    return {
      // An account provisioned through SSO has no password to step up with.
      ssoOnly: !!u?.passwordHash?.startsWith('!'),
      providers: ids.map((i) => ({
        id: i.provider.id, name: i.provider.name, mfa: !!i.provider.acrMfa,
        passkey: !!i.provider.acrPasskey && i.provider.trustIdpPasskey,
      })).filter((p) => p.mfa || p.passkey),
    };
  }

  async startStepUp(userId: string, sessionIat: number | undefined, body: { providerId?: string; phishingResistant?: boolean; returnTo?: string }) {
    const need: 'mfa' | 'passkey' = body.phishingResistant === true ? 'passkey' : 'mfa';
    const opts = await this.stepUpOptions(userId);
    const p = opts.providers.find((x) => (!body.providerId || x.id === body.providerId) && (need === 'passkey' ? x.passkey : x.mfa));
    if (!p) throw new ConflictException({ code: 'SSO_STEP_UP_UNAVAILABLE', message: need === 'passkey' ? 'No linked provider is trusted for passkey confirmation.' : 'No linked provider is set up to confirm it is you.' });
    await this.audit.log({ actorId: userId, action: 'SSO_STEP_UP', resource: 'oidc_provider', resourceId: p.id, meta: { level: need } });
    return this.start(p.id, 'STEP_UP', { userId, sessionIat: sessionIat ?? 0, requiredLevel: need, returnTo: body.returnTo });
  }

  // ── RP-initiated logout (0.59) ─────────────────────────────────────────

  /**
   * The provider's end-session URL for the SSO sign-in that minted this
   * session token, with the ID token as the hint and a registered
   * post-logout redirect. Null when the session did not come from SSO, the
   * provider has no end_session_endpoint, or anything fails.
   */
  async endSessionUrl(userId: string, sessionIat: number | undefined): Promise<string | null> {
    if (sessionIat === undefined) return null;
    const s = await this.prisma.ssoSession.findFirst({ where: { userId, sessionIat, endedAt: null }, include: { provider: true }, orderBy: { createdAt: 'desc' } });
    if (!s || !s.provider.enabled) return null;
    try {
      const cfg = await this.configuration(s.provider);
      if (!cfg.serverMetadata().end_session_endpoint) return null;
      const params: Record<string, string> = { post_logout_redirect_uri: s.provider.postLogoutRedirectUri ?? this.endpoints(s.provider.id).defaultPostLogoutRedirectUri };
      if (s.idTokenEnc) params.id_token_hint = openSecret(this.encKey, 'rem0te-oidc-id-token-v1', s.idTokenEnc);
      const url = oidc.buildEndSessionUrl(cfg, params);
      await this.audit.log({ actorId: userId, action: 'SSO_LOGOUT', resource: 'oidc_provider', resourceId: s.providerId, meta: { ssoSessionId: s.id, hint: !!s.idTokenEnc } });
      return url.href;
    } catch (e) {
      this.logger.warn(`end-session URL for provider ${s.providerId} failed: ${(e as Error).message}`);
      return null;
    }
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
    // 0.59: under ssoMode=required, unlinking the last identity would turn
    // password sign-in back on for this account. A Platform Admin lowers the
    // mode first, or the recovery CLI unlinks from the host.
    const { mode } = await this.auth.ssoModeFor(userId);
    if (mode === 'required' && (await this.prisma.externalIdentity.count({ where: { userId, provider: { enabled: true }, NOT: { id: r.id } } })) === 0) {
      throw new ConflictException({ code: 'SSO_REQUIRED_KEEP_LINK', message: 'Your organisation requires single sign-on, so your last linked identity cannot be removed.' });
    }
    await this.prisma.externalIdentity.delete({ where: { id: r.id } });
    await this.audit.log({ actorId: userId, actorIp: ip, action: 'SSO_UNLINKED', resource: 'oidc_provider', resourceId: r.providerId });
    return { deleted: true };
  }
}
