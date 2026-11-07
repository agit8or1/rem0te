import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The address people and computers use to reach this server.
 *
 * Every install is reached at a different address, and the address is baked
 * into things that leave the server: support links, SSO redirects, the
 * passkey relying party, launcher deep links, installer downloads and the
 * diagnostics helper. Until 0.21 it came only from FRONTEND_URL and
 * PUBLIC_API_URL in the API's environment file, which needs a shell on the
 * server to change.
 *
 * Resolution, highest first:
 *   1. PlatformSettings.publicUrl — set from Settings → General by a Platform Admin
 *   2. FRONTEND_URL (web) / PUBLIC_API_URL (API) from the environment
 *   3. the built-in development defaults
 *
 * One address serves both the web app and the API: the web app proxies
 * /api/v1 to the API, and every supported install puts both behind the same
 * host. An install that splits them leaves the setting empty and keeps the
 * two environment variables.
 *
 * Reads are synchronous from an in-memory copy, refreshed when the setting is
 * saved and every minute (so a change made by dist/cli/auth-recovery.js, or by
 * another process, is picked up without a restart).
 *
 * What this does NOT change: managed computers check in through the RustDesk
 * relay host (Settings → RustDesk), not this address, so enrolled computers
 * are unaffected by it.
 */
@Injectable()
export class PublicUrlService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PublicUrlService.name);
  private setting: string | null = null;
  private timer?: NodeJS.Timeout;
  /** Nonces for the reachability check: issued, then answered by the public probe route. */
  private readonly probes = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    try {
      const s = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { publicUrl: true } });
      this.setting = s?.publicUrl ? s.publicUrl : null;
    } catch (e) {
      // Keep the last known value; never fail a request path over this.
      this.log.warn(`could not read the public address setting: ${(e as Error).message}`);
    }
  }

  /** Apply a just-saved value without waiting for the next refresh. */
  applySaved(value: string | null) {
    this.setting = value;
  }

  private static trim(v: string | undefined | null): string | null {
    const t = (v ?? '').trim().replace(/\/+$/, '');
    return t || null;
  }

  /** The setting, if a Platform Admin has set one. */
  settingValue(): string | null {
    return this.setting;
  }

  /** Web app base, or null when neither the setting nor FRONTEND_URL is set. */
  webConfigured(): string | null {
    return this.setting ?? PublicUrlService.trim(process.env.FRONTEND_URL);
  }

  /** API base, or null when neither the setting nor PUBLIC_API_URL is set. */
  apiConfigured(): string | null {
    return this.setting ?? PublicUrlService.trim(process.env.PUBLIC_API_URL);
  }

  /** Web app base, always a value (development default last). */
  web(): string {
    return this.webConfigured()
      ?? PublicUrlService.trim(this.config.get<string>('FRONTEND_URL'))
      ?? 'http://localhost:3000';
  }

  /** API base, always a value (development default last). */
  api(): string {
    return this.apiConfigured()
      ?? PublicUrlService.trim(this.config.get<string>('PUBLIC_API_URL'))
      ?? 'http://localhost:3001';
  }

  /** Origins the API answers CORS for: the current address and the environment's. */
  corsOrigins(): string[] {
    const out = new Set<string>();
    for (const v of [this.setting, PublicUrlService.trim(process.env.FRONTEND_URL), this.web()]) {
      if (!v) continue;
      try { out.add(new URL(v).origin); } catch { /* not a URL */ }
    }
    return [...out];
  }

  /** What the settings page shows: the effective address and where it came from. */
  describe() {
    const envWeb = PublicUrlService.trim(process.env.FRONTEND_URL);
    const envApi = PublicUrlService.trim(process.env.PUBLIC_API_URL);
    return {
      effective: this.web(),
      effectiveApi: this.api(),
      source: this.setting ? 'setting' as const : (envWeb || envApi) ? 'environment' as const : 'default' as const,
      setting: this.setting,
      environment: { FRONTEND_URL: envWeb, PUBLIC_API_URL: envApi },
      // Passkeys are bound to the RP ID. If it is pinned in the environment, a
      // change of address does not touch them; otherwise it follows the address.
      webauthnRpIdPinned: !!PublicUrlService.trim(process.env.WEBAUTHN_RP_ID),
    };
  }

  /**
   * Validate and normalise an address to a bare origin. https is required in
   * production: this address goes into installers that run elevated, and the
   * installer binary refuses anything else.
   */
  static normalize(input: string, production = process.env.NODE_ENV === 'production'): string {
    const raw = (input ?? '').trim();
    if (!raw) throw new BadRequestException('Enter an address, such as https://remote.example.com');
    if (raw.length > 200) throw new BadRequestException('That address is too long');
    let u: URL;
    try { u = new URL(raw); } catch { throw new BadRequestException('Enter a full address starting with https://'); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new BadRequestException('The address must start with https://');
    if (production && u.protocol !== 'https:') {
      throw new BadRequestException('The address must use https://. Installers and passkeys refuse plain http.');
    }
    if (u.username || u.password) throw new BadRequestException('The address must not contain a user name or password');
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
      throw new BadRequestException('Enter only the address, with no path: for example https://remote.example.com');
    }
    // The installer's URL slot accepts only this charset (see public.controller).
    if (!/^[a-z0-9.-]+$/i.test(u.hostname) || u.hostname.startsWith('.') || u.hostname.endsWith('.')) {
      throw new BadRequestException('The host name contains characters that are not allowed');
    }
    return u.origin;
  }

  // ── Reachability check ────────────────────────────────────────────────────

  /** Answer the public probe: true only for a nonce this process issued and has not seen answered. */
  answerProbe(nonce: string): boolean {
    const exp = this.probes.get(nonce);
    if (!exp) return false;
    this.probes.delete(nonce);
    return exp > Date.now();
  }

  /**
   * Fetch <address>/api/v1/public/address-probe/<nonce> from here. Only this
   * process knows the nonce, so a `true` answer proves the address routes back
   * to this server rather than to some other one. Redirects are not followed.
   */
  async check(address: string): Promise<{ address: string; reachable: boolean; sameServer: boolean; detail: string }> {
    const origin = PublicUrlService.normalize(address);
    for (const [k, exp] of this.probes) if (exp < Date.now()) this.probes.delete(k);
    const nonce = randomBytes(18).toString('base64url');
    this.probes.set(nonce, Date.now() + 30_000);
    try {
      const res = await fetch(`${origin}/api/v1/public/address-probe/${nonce}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
        headers: { accept: 'application/json' },
      });
      if (res.status >= 300 && res.status < 400) {
        return { address: origin, reachable: true, sameServer: false, detail: `The address redirects (HTTP ${res.status}) to ${res.headers.get('location') ?? 'elsewhere'}. Use the address it redirects to.` };
      }
      const text = (await res.text()).slice(0, 2000);
      let ok = false;
      try { ok = (JSON.parse(text) as { data?: { ok?: boolean } })?.data?.ok === true; } catch { /* not ours */ }
      if (ok) return { address: origin, reachable: true, sameServer: true, detail: 'This address reaches this server.' };
      return { address: origin, reachable: true, sameServer: false, detail: `Something answered (HTTP ${res.status}), but it is not this server.` };
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const why = err.name === 'TimeoutError' ? 'no answer within 8 seconds' : (err.cause?.code ?? err.cause?.message ?? err.message);
      return { address: origin, reachable: false, sameServer: false, detail: `Could not reach it from the server: ${why}.` };
    } finally {
      this.probes.delete(nonce);
    }
  }
}
