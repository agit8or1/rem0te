import {
  Controller, Get, Logger, NotFoundException, Param, Res, ServiceUnavailableException,
} from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { PlatformSettingsService } from '../platform/platform-settings.service';

const HOSTNAME_RE = /^[a-zA-Z0-9._-]{1,253}$/;
const BASE64_KEY_RE = /^[A-Za-z0-9+/]{16,512}={0,2}$/;
/** Characters Windows will not accept in a filename. */
const WINDOWS_ILLEGAL_RE = /[<>:"/\\|?*\x00-\x1f]/;

/**
 * Public Quick Connect surface — the /quick landing page and the client
 * download. No authentication: someone who needs help has no account, and
 * requiring one to receive a support session would defeat the point.
 *
 * Nothing here exposes the administration console, business names, user
 * identities or any enrolled computer. It answers exactly two questions:
 * "is Quick Connect on" and "give me the client".
 */
@Controller('public/quick-connect')
export class QuickConnectPublicController {
  private readonly logger = new Logger(QuickConnectPublicController.name);
  private readonly cacheDir = path.join(
    process.env.PROJECT_ROOT ?? process.cwd(),
    'cache',
    'quick-connect',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  // ── Landing page data ─────────────────────────────────────────────────────

  @Get()
  @Public()
  async info() {
    const settings = await this.platformSettings.get();
    if (!settings.quickConnectEnabled) {
      return { success: true, data: { enabled: false, downloads: [], branding: null } };
    }

    const branding = await this.prisma.tenantBranding.findFirst({
      select: { portalTitle: true, logoUrl: true, accentColor: true, supportEmail: true, supportPhone: true },
      orderBy: { createdAt: 'asc' },
    });

    // Only advertise platforms we can actually hand a preconfigured build for.
    const configured = await this.rustdeskConfig().catch(() => null);
    const downloads = configured ? await this.platformSettings.availableClients() : [];

    return {
      success: true,
      data: {
        enabled: true,
        configured: !!configured,
        downloads,
        branding: branding ?? null,
      },
    };
  }

  // ── Client download ───────────────────────────────────────────────────────

  /**
   * Serves the Quick Connect client, preconfigured for this Rem0te install.
   *
   * The person downloading it never types a relay host, ID server or key.
   * That is achieved with RustDesk's documented config-in-filename mechanism:
   * the executable is delivered named
   *
   *     rustdesk-host=<our-host>,key=<our-key>.exe
   *
   * and RustDesk reads its own filename on first run. Same binary RustDesk
   * ships — we are not reimplementing the client, only naming it.
   *
   * Run-only by design: the person double-clicks it, RustDesk shows its own
   * window with the ID, the password and the connection status, and closing
   * that window ends their availability. Nothing is installed as a service
   * and no managed computer is created.
   */
  @Get('download/:os')
  @Public()
  async download(@Param('os') os: string, @Res() res: Response) {
    const settings = await this.platformSettings.get();
    if (!settings.quickConnectEnabled) {
      throw new NotFoundException('Quick Connect is not available');
    }

    if (os !== 'windows') {
      // macOS and Linux have no preconfigured build yet. Handing over a
      // vanilla installer that points at public RustDesk infrastructure would
      // be worse than saying so.
      throw new NotFoundException(
        'The Quick Connect client is currently available for Windows only.',
      );
    }
    if (!settings.quickConnectWindows) {
      throw new NotFoundException('The Windows Quick Connect client is not enabled');
    }

    const config = await this.rustdeskConfig();
    const version = await this.latestRustdeskVersion();
    const exePath = await this.ensureCachedClient(version);

    const filename = `rustdesk-host=${config.host},key=${config.key}.exe`;
    const stat = fs.statSync(exePath);

    res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(exePath).pipe(res);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * Our RustDesk server details, validated hard.
   *
   * These values end up inside a Windows filename that the customer's machine
   * then trusts as its server configuration, so a malformed or hostile value
   * must fail loudly rather than produce a client pointed somewhere else.
   */
  private async rustdeskConfig(): Promise<{ host: string; key: string }> {
    const settings = await this.prisma.tenantSettings.findFirst({
      select: { rustdeskRelayHost: true, rustdeskPublicKey: true },
      orderBy: { createdAt: 'asc' },
    });

    const host = settings?.rustdeskRelayHost ?? '';
    const key = settings?.rustdeskPublicKey ?? '';

    if (!host || !HOSTNAME_RE.test(host)) {
      throw new ServiceUnavailableException(
        'Quick Connect is not configured: no RustDesk relay host is set. A Platform Admin must set it under Settings.',
      );
    }
    if (!key || !BASE64_KEY_RE.test(key)) {
      throw new ServiceUnavailableException(
        'Quick Connect is not configured: no RustDesk public key is set.',
      );
    }
    // The config travels in a filename. A key containing a character Windows
    // rejects would be silently mangled and produce a client that cannot
    // reach us — refuse rather than ship something broken.
    if (WINDOWS_ILLEGAL_RE.test(host) || WINDOWS_ILLEGAL_RE.test(key)) {
      throw new ServiceUnavailableException(
        'Quick Connect cannot be packaged: the RustDesk public key contains a character that is not valid in a Windows filename. Regenerate the server key pair.',
      );
    }

    return { host, key };
  }

  /** Cached RustDesk release tag; refreshed hourly. */
  private versionCache: { version: string; fetchedAt: number } | null = null;

  private async latestRustdeskVersion(): Promise<string> {
    const FALLBACK = '1.4.9';
    if (this.versionCache && Date.now() - this.versionCache.fetchedAt < 3_600_000) {
      return this.versionCache.version;
    }
    return new Promise((resolve) => {
      const req = https.get(
        'https://api.github.com/repos/rustdesk/rustdesk/releases/latest',
        { headers: { 'User-Agent': 'reboot-remote', Accept: 'application/vnd.github.v3+json' } },
        (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => {
            try {
              const tag = String(JSON.parse(data).tag_name ?? FALLBACK);
              const version = /^[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) ? tag : FALLBACK;
              this.versionCache = { version, fetchedAt: Date.now() };
              resolve(version);
            } catch {
              resolve(FALLBACK);
            }
          });
        },
      );
      req.on('error', () => resolve(FALLBACK));
      req.setTimeout(5000, () => { req.destroy(); resolve(FALLBACK); });
    });
  }

  /**
   * Keep one copy of the RustDesk binary on disk so a support call does not
   * depend on GitHub being reachable at the moment someone needs help.
   */
  private async ensureCachedClient(version: string): Promise<string> {
    const target = path.join(this.cacheDir, `rustdesk-${version}-x86_64.exe`);
    if (fs.existsSync(target) && fs.statSync(target).size > 1_000_000) return target;

    fs.mkdirSync(this.cacheDir, { recursive: true });
    const url = `https://github.com/rustdesk/rustdesk/releases/download/${version}/rustdesk-${version}-x86_64.exe`;
    const tmp = `${target}.part`;

    this.logger.log(`Caching Quick Connect client ${version} from ${url}`);
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      const get = (u: string, redirects = 0) => {
        if (redirects > 5) return reject(new Error('Too many redirects'));
        https.get(u, { headers: { 'User-Agent': 'reboot-remote' } }, (r) => {
          if (r.statusCode && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
            r.resume();
            return get(r.headers.location, redirects + 1);
          }
          if (r.statusCode !== 200) {
            r.resume();
            return reject(new Error(`Download failed with HTTP ${r.statusCode}`));
          }
          r.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
        }).on('error', reject);
      };
      get(url);
    }).catch((err) => {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      this.logger.error(`Quick Connect client download failed: ${err.message}`);
      throw new ServiceUnavailableException(
        'The Quick Connect client could not be prepared. Try again in a moment.',
      );
    });

    fs.renameSync(tmp, target);
    return target;
  }
}
