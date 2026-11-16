import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createPublicKey, verify as cryptoVerify, constants as cryptoConstants } from 'crypto';

type JsonWebKey = { kty?: string; kid?: string; use?: string; alg?: string; [k: string]: unknown };
import * as oidc from 'openid-client';
import type { OidcProvider, SsoSession } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import { SecurityAlertService } from '../security-controls/alerts.service';
import { ControlsStore } from '../security-controls/controls.store';
import { openSecret, sealSecret } from '../common/secret-box';
import { SsoService } from './sso.service';
import { logoutClaimsDecision } from './identity-policy';

/** How often the sweep runs, and how often one session's refresh is checked. */
export const SWEEP_SECONDS_DEFAULT = 60;
export const CHECK_SECONDS_DEFAULT = 600;
/** Sessions checked per pass, and the floors outside tests. */
export const SWEEP_BATCH = 50;
export const SWEEP_SECONDS_FLOOR = 30;
export const CHECK_SECONDS_FLOOR = 60;
/** One fail-open alert per provider per hour, however many sessions failed. */
const FAIL_OPEN_ALERT_EVERY_MS = 60 * 60_000;
const ENDED_KEEP_MS = 30 * 24 * 60 * 60_000;
const SUGGESTION_KEEP_MS = 90 * 24 * 60 * 60_000;
const JWKS_TTL_MS = 10 * 60_000;
const JWKS_MAX_BYTES = 256 * 1024;

function seconds(env: string | undefined, def: number, floor: number): number {
  const n = Number(env);
  if (!Number.isFinite(n) || n <= 0) return def;
  return process.env.NODE_ENV === 'test' ? Math.max(1, Math.floor(n)) : Math.max(floor, Math.floor(n));
}

type BcResult = { ok: true; users: number } | { ok: false; reason: string };

/**
 * SSO sessions after sign-in (0.59):
 *
 *   back-channel logout   POST /auth/sso/backchannel-logout, per OpenID
 *                         Connect Back-Channel Logout 1.0: the logout_token
 *                         is verified against the provider's JWKS (never
 *                         none, never HMAC), iss, aud, iat window, the
 *                         `events` member, no nonce, a jti used once, and a
 *                         sub and/or sid. Every session of the account ends.
 *   the safety-net sweep  every ~10 minutes an SSO session's refresh token is
 *                         tried at the provider. invalid_grant ends the
 *                         account's sessions. A failure to reach the provider
 *                         fails open (a warning and a security alert) unless
 *                         the provider is set to fail closed.
 *                         SSO_SESSION_SWEEP=off stops it, exactly.
 *
 * It also registers AuthService's hooks: the end-session URL on sign-out.
 */
@Injectable()
export class SsoSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SsoSessions');
  private readonly encKey: string | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly jwks = new Map<string, { at: number; keys: JsonWebKey[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    private readonly sso: SsoService,
    private readonly alerts: SecurityAlertService,
    private readonly controls: ControlsStore,
    config: ConfigService,
  ) {
    this.encKey = config.get<string>('ENCRYPTION_KEY');
  }

  onModuleInit() {
    this.auth.setHooks({ endSessionUrl: (u, iat) => this.sso.endSessionUrl(u, iat) });
    if (process.env.SSO_SESSION_SWEEP === 'off') return;
    const every = seconds(process.env.SSO_SESSION_SWEEP_SECONDS, SWEEP_SECONDS_DEFAULT, SWEEP_SECONDS_FLOOR);
    this.timer = setInterval(() => { void this.tick(); }, every * 1000);
    this.timer.unref?.();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  // ── The sweep ───────────────────────────────────────────────────────────

  async tick(now = Date.now()): Promise<{ expired: number; checked: number }> {
    if (this.busy) return { expired: 0, checked: 0 };
    this.busy = true;
    try {
      const at = new Date(now);
      const expired = await this.prisma.ssoSession.updateMany({ where: { endedAt: null, expiresAt: { lt: at } }, data: { endedAt: at, endReason: 'expired' } });
      const checkMs = seconds(process.env.SSO_SESSION_CHECK_SECONDS, CHECK_SECONDS_DEFAULT, CHECK_SECONDS_FLOOR) * 1000;
      const due = await this.prisma.ssoSession.findMany({
        where: { endedAt: null, sessionIat: { not: null }, refreshTokenEnc: { not: null }, lastCheckedAt: { lt: new Date(now - checkMs) } },
        orderBy: { lastCheckedAt: 'asc' }, take: SWEEP_BATCH, include: { provider: true },
      });
      let checked = 0;
      for (const s of due) { if (await this.checkOne(s, at)) checked++; }
      await this.prune(now);
      return { expired: expired.count, checked };
    } catch (e) {
      this.logger.error(`sweep failed: ${(e as Error).message}`);
      return { expired: 0, checked: 0 };
    } finally {
      this.busy = false;
    }
  }

  private async prune(now: number) {
    const before = new Date(now - ENDED_KEEP_MS);
    await this.prisma.ssoSession.deleteMany({ where: { endedAt: { lt: before } } });
    await this.prisma.ssoLogoutReplay.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
    await this.prisma.ssoLinkSuggestion.deleteMany({ where: { lastSeenAt: { lt: new Date(now - SUGGESTION_KEEP_MS) } } });
  }

  /** One session. Returns whether it was this process that checked it. */
  async checkOne(s: SsoSession & { provider: OidcProvider }, at: Date): Promise<boolean> {
    // Claim it: another process checking the same row moves on.
    const claimed = await this.prisma.ssoSession.updateMany({ where: { id: s.id, endedAt: null, lastCheckedAt: s.lastCheckedAt }, data: { lastCheckedAt: at } });
    if (claimed.count !== 1) return false;
    // A disabled provider (the recovery CLI during an outage) is not asked; nothing is ended for it.
    if (!s.provider.enabled || !s.refreshTokenEnc) return true;
    let refresh: string;
    try { refresh = openSecret(this.encKey, 'rem0te-oidc-refresh-v1', s.refreshTokenEnc); } catch { await this.end(s, 'refresh_unreadable'); return true; }
    try {
      const cfg = await this.sso.configuration(s.provider);
      const t = await oidc.refreshTokenGrant(cfg, refresh);
      const next = typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : refresh;
      await this.prisma.ssoSession.updateMany({ where: { id: s.id, endedAt: null }, data: { refreshTokenEnc: sealSecret(this.encKey, 'rem0te-oidc-refresh-v1', next) } });
    } catch (e) {
      const err = e as { error?: unknown };
      if (e instanceof oidc.ResponseBodyError && err.error === 'invalid_grant') {
        await this.end(s, 'invalid_grant');
      } else if (s.provider.sessionCheckFailMode === 'closed') {
        await this.end(s, 'check_failed');
      } else {
        const detail = e instanceof oidc.ResponseBodyError ? ` (${String(err.error).slice(0, 40)})` : '';
        this.logger.warn(`SSO session check for provider ${s.providerId} could not reach the provider (failing open): ${(e as Error).message}${detail}`);
        await this.failOpenAlert(s.provider, (e as Error).name);
      }
    }
    return true;
  }

  private async end(s: SsoSession, reason: string) {
    await this.auth.revokeSessions(s.userId, `sso_${reason}`);
    await this.audit.log({ actorId: s.userId, action: 'SSO_SESSION_REVOKED', resource: 'oidc_provider', resourceId: s.providerId, meta: { reason, ssoSessionId: s.id } });
  }

  private async failOpenAlert(p: OidcProvider, errorName: string) {
    const identity = `provider:${p.id}`;
    const recent = await this.prisma.securityAlert.count({ where: { kind: 'sso_session_check_failed', identity, createdAt: { gt: new Date(Date.now() - FAIL_OPEN_ALERT_EVERY_MS) } } });
    if (recent) return;
    const controls = await this.controls.platform();
    await this.alerts.raise({
      kind: 'sso_session_check_failed', identity,
      details: { providerId: p.id, provider: p.name, failMode: 'open', error: errorName.slice(0, 40) },
      destinations: controls.alertDestinations,
    });
  }

  // ── Back-channel logout ────────────────────────────────────────────────

  private async fetchJwks(p: OidcProvider, force: boolean): Promise<JsonWebKey[]> {
    const hit = this.jwks.get(p.id);
    if (hit && !force && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
    // A forced refetch at most once a minute: an unknown kid cannot make us hammer the provider.
    if (hit && force && Date.now() - hit.at < 60_000) return hit.keys;
    const cfg = await this.sso.configuration(p);
    const uri = cfg.serverMetadata().jwks_uri;
    if (!uri) throw new Error('no jwks_uri');
    const u = this.sso.checkUrl('JWKS URI', uri);
    const r = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`jwks HTTP ${r.status}`);
    const text = await r.text();
    if (text.length > JWKS_MAX_BYTES) throw new Error('jwks too large');
    const keys = (JSON.parse(text) as { keys?: unknown }).keys;
    const list = Array.isArray(keys) ? (keys.filter((k) => k && typeof k === 'object') as JsonWebKey[]).slice(0, 50) : [];
    this.jwks.set(p.id, { at: Date.now(), keys: list });
    return list;
  }

  private static kty(alg: string) { return alg === 'ES256' ? 'EC' : alg === 'EdDSA' ? 'OKP' : 'RSA'; }

  private verifySig(alg: string, jwk: JsonWebKey, input: string, sig: Buffer): boolean {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' });
    const data = Buffer.from(input);
    switch (alg) {
      case 'RS256': return cryptoVerify('sha256', data, { key, padding: cryptoConstants.RSA_PKCS1_PADDING }, sig);
      case 'PS256': return cryptoVerify('sha256', data, { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
      case 'ES256': return cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
      case 'EdDSA': return cryptoVerify(null, data, key, sig);
      default: return false;
    }
  }

  /** Verify a logout token's signature against the provider's published keys. */
  private async signatureOk(p: OidcProvider, header: Record<string, unknown>, input: string, sig: Buffer): Promise<boolean> {
    const alg = String(header.alg);
    const kid = typeof header.kid === 'string' ? header.kid : null;
    const pick = (keys: JsonWebKey[]) => keys.filter((k) => {
      const j = k as JsonWebKey & { kid?: string; use?: string; alg?: string };
      if (j.kty !== SsoSessionService.kty(alg)) return false;
      if (j.use && j.use !== 'sig') return false;
      if (j.alg && j.alg !== alg) return false;
      return kid ? j.kid === kid : true;
    });
    let cands = pick(await this.fetchJwks(p, false));
    if (!cands.length && kid) cands = pick(await this.fetchJwks(p, true));
    // Without a kid there must be exactly one candidate.
    if (!kid && cands.length !== 1) return false;
    for (const k of cands) {
      try { if (this.verifySig(alg, k, input, sig)) return true; } catch { /* a malformed key verifies nothing */ }
    }
    return false;
  }

  async backchannelLogout(token: unknown, ip: string): Promise<BcResult> {
    if (typeof token !== 'string' || token.length > 8192) return { ok: false, reason: 'malformed' };
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'malformed' };
    let header: Record<string, unknown>, claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch { return { ok: false, reason: 'malformed' }; }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return { ok: false, reason: 'malformed' };
    if (typeof claims.iss !== 'string') return { ok: false, reason: 'iss' };
    // The issuer only chooses whose keys to try; nothing is trusted until they verify.
    const p = await this.prisma.oidcProvider.findUnique({ where: { issuer: claims.iss } });
    if (!p) return { ok: false, reason: 'unknown_issuer' };
    const now = Math.floor(Date.now() / 1000);
    const d = logoutClaimsDecision(header, claims, { issuer: p.issuer, clientId: p.clientId, now });
    if (!d.ok && d.reason === 'alg') return d;
    let sigOk: boolean;
    try { sigOk = await this.signatureOk(p, header, `${parts[0]}.${parts[1]}`, Buffer.from(parts[2], 'base64url')); } catch (e) {
      this.logger.warn(`back-channel logout: provider ${p.id} keys unavailable: ${(e as Error).message}`);
      return { ok: false, reason: 'keys_unavailable' };
    }
    if (!sigOk) return { ok: false, reason: 'signature' };
    // Signed by the provider from here on: refusals are worth an audit entry.
    if (!d.ok) {
      await this.audit.log({ actorIp: ip, action: 'SSO_BACKCHANNEL_LOGOUT', resource: 'oidc_provider', resourceId: p.id, meta: { outcome: 'refused', reason: d.reason } });
      return d;
    }
    const key = createHash('sha256').update(`${p.id}:${d.jti}`).digest('hex');
    const fresh = await this.prisma.ssoLogoutReplay.create({ data: { key, expiresAt: new Date((d.exp + 600) * 1000) } }).then(() => true, () => false);
    if (!fresh) {
      await this.audit.log({ actorIp: ip, action: 'SSO_BACKCHANNEL_LOGOUT', resource: 'oidc_provider', resourceId: p.id, meta: { outcome: 'refused', reason: 'replay' } });
      return { ok: false, reason: 'replay' };
    }
    const userIds = new Set<string>();
    if (d.sid) {
      const rows = await this.prisma.ssoSession.findMany({ where: { providerId: p.id, sid: d.sid, ...(d.sub ? { subject: d.sub } : {}) }, select: { userId: true }, take: 50 });
      for (const r of rows) userIds.add(r.userId);
    } else if (d.sub) {
      const ident = await this.prisma.externalIdentity.findUnique({ where: { issuer_subject: { issuer: p.issuer, subject: d.sub } }, select: { userId: true } });
      if (ident) userIds.add(ident.userId);
    }
    // Rem0te's revocation is per account (sessionsValidAfter), so ending one
    // provider session ends every Rem0te session of that account.
    for (const u of userIds) await this.auth.revokeSessions(u, 'sso_backchannel');
    await this.audit.log({
      actorId: [...userIds][0], actorIp: ip, action: 'SSO_BACKCHANNEL_LOGOUT', resource: 'oidc_provider', resourceId: p.id,
      meta: { outcome: 'ok', bySid: !!d.sid, bySub: !!d.sub, users: userIds.size },
    });
    return { ok: true, users: userIds.size };
  }
}
