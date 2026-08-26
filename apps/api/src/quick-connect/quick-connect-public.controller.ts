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
/**
 * Characters Windows will not accept in a filename.
 *
 * The control-character range is deliberate — it is exactly what this guard
 * exists to catch, since the value ends up in a Content-Disposition filename.
 */
// eslint-disable-next-line no-control-regex -- control chars are the subject of the check
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

    const enabled: Record<string, boolean> = {
      windows: settings.quickConnectWindows,
      macos: settings.quickConnectMacos,
      linux: settings.quickConnectLinux,
    };
    if (!(os in enabled)) throw new NotFoundException('Unknown platform');
    if (!enabled[os]) throw new NotFoundException(`The ${os} Quick Connect client is not enabled`);

    const config = await this.rustdeskConfig();
    const version = await this.latestRustdeskVersion();

    if (os === 'windows') {
      // Windows gets the real binary, preconfigured through its filename.
      const exePath = await this.ensureCachedClient(version);
      const filename = `rustdesk-host=${config.host},key=${config.key}.exe`;
      const stat = fs.statSync(exePath);

      res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(exePath).pipe(res);
      return;
    }

    // macOS and Linux get a launcher script instead of a binary: RustDesk's
    // config-in-filename trick is specific to the Windows setup executable,
    // and repackaging their signed .app would break its signature.
    const script = os === 'macos'
      ? this.buildMacosQuickConnect(config, version)
      : this.buildLinuxQuickConnect(config, version);

    const filename = os === 'macos'
      ? 'Rem0te Quick Connect.command'
      : 'rem0te-quick-connect.sh';

    res.setHeader('Content-Type', 'application/x-shellscript; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  }

  /**
   * macOS Quick Connect.
   *
   * Runs RustDesk straight off the mounted disk image with a throwaway HOME,
   * so:
   *   • nothing is installed — the .app is never copied to /Applications
   *   • an existing RustDesk install's config is never touched, because the
   *     temporary HOME is where this instance reads and writes its settings
   *   • quitting RustDesk ends the session, and the temp directory goes with it
   *
   * The binary is RustDesk's own, still inside their signed .app bundle, so
   * Gatekeeper sees an untampered signature.
   */
  private buildMacosQuickConnect(config: { host: string; key: string }, version: string): string {
    return `#!/bin/bash
# Rem0te Quick Connect — temporary remote support for macOS
#
# Nothing is installed. Nothing on this Mac is modified. Quit RustDesk (or
# close this window) and every trace is removed.
set -uo pipefail

HOST='${config.host}'
KEY='${config.key}'
VERSION='${version}'

WORK="$(mktemp -d /tmp/rem0te-quickconnect.XXXXXX)"
MOUNT="$WORK/mnt"
QC_HOME="$WORK/home"
mkdir -p "$MOUNT" "$QC_HOME"

cleanup() {
  echo ""
  echo "  Cleaning up…"
  /usr/bin/hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
  echo "  Quick Connect closed. Nothing was left on this Mac."
}
trap cleanup EXIT INT TERM

echo ""
echo "  Rem0te Quick Connect"
echo "  ────────────────────────────────────────────"
echo ""

if [ "$(uname -m)" = "arm64" ]; then
  DMG="rustdesk-\${VERSION}-aarch64.dmg"
else
  DMG="rustdesk-\${VERSION}-x86_64.dmg"
fi

echo "  [1/3] Downloading the support client…"
if ! curl -fsSL -o "$WORK/rustdesk.dmg" \
     "https://github.com/rustdesk/rustdesk/releases/download/\${VERSION}/\${DMG}"; then
  echo "  Could not download the support client. Check your internet connection."
  read -r -p "  Press Return to close." _
  exit 1
fi

echo "  [2/3] Opening it…"
if ! /usr/bin/hdiutil attach "$WORK/rustdesk.dmg" -quiet -nobrowse -mountpoint "$MOUNT"; then
  echo "  Could not open the support client."
  read -r -p "  Press Return to close." _
  exit 1
fi

APP="$MOUNT/RustDesk.app/Contents/MacOS/rustdesk"
if [ ! -x "$APP" ]; then
  echo "  The support client looks damaged. Please ask for a fresh link."
  read -r -p "  Press Return to close." _
  exit 1
fi

# Point this instance at the Rem0te server. HOME is the throwaway directory
# above, so this writes nowhere near any real RustDesk configuration.
mkdir -p "$QC_HOME/Library/Preferences/com.carriez.RustDesk"
cat > "$QC_HOME/Library/Preferences/com.carriez.RustDesk/RustDesk2.toml" <<TOML
rendezvous_server = '\${HOST}:21116'
nat_type = 1
serial = 3

[options]
custom-rendezvous-server = '\${HOST}'
relay-server = '\${HOST}'
api-server = 'https://\${HOST}'
key = '\${KEY}'
allow-websocket = 'Y'
TOML

echo "  [3/3] Starting…"
echo ""
echo "  RustDesk will open in a moment. Read the ID and the password it shows"
echo "  to the person helping you, and leave it open until they are finished."
echo ""
echo "  Keep this window open too — closing it ends the session."
echo ""

HOME="$QC_HOME" "$APP"
`;
  }

  /**
   * Linux Quick Connect. Same isolation approach as macOS, using the AppImage —
   * a single executable, so there is nothing to mount or install.
   */
  private buildLinuxQuickConnect(config: { host: string; key: string }, version: string): string {
    return `#!/bin/bash
# Rem0te Quick Connect — temporary remote support for Linux
#
# Nothing is installed. Nothing in your home directory is modified. Quit
# RustDesk (or close this terminal) and every trace is removed.
set -uo pipefail

HOST='${config.host}'
KEY='${config.key}'
VERSION='${version}'

WORK="$(mktemp -d /tmp/rem0te-quickconnect.XXXXXX)"
QC_HOME="$WORK/home"
mkdir -p "$QC_HOME/.config/rustdesk"

cleanup() {
  echo ""
  echo "  Cleaning up…"
  rm -rf "$WORK"
  echo "  Quick Connect closed. Nothing was left on this machine."
}
trap cleanup EXIT INT TERM

echo ""
echo "  Rem0te Quick Connect"
echo "  ────────────────────────────────────────────"
echo ""

case "$(uname -m)" in
  aarch64|arm64) ARCH="aarch64" ;;
  *)             ARCH="x86_64"  ;;
esac

echo "  [1/2] Downloading the support client…"
if ! curl -fsSL -o "$WORK/rustdesk.AppImage" \
     "https://github.com/rustdesk/rustdesk/releases/download/\${VERSION}/rustdesk-\${VERSION}-\${ARCH}.AppImage"; then
  echo "  Could not download the support client. Check your internet connection."
  exit 1
fi
chmod +x "$WORK/rustdesk.AppImage"

cat > "$QC_HOME/.config/rustdesk/RustDesk2.toml" <<TOML
rendezvous_server = '\${HOST}:21116'
nat_type = 1
serial = 3

[options]
custom-rendezvous-server = '\${HOST}'
relay-server = '\${HOST}'
api-server = 'https://\${HOST}'
key = '\${KEY}'
allow-websocket = 'Y'
TOML

echo "  [2/2] Starting…"
echo ""
echo "  RustDesk will open in a moment. Read the ID and the password it shows"
echo "  to the person helping you, and leave it open until they are finished."
echo ""
echo "  Keep this terminal open too — closing it ends the session."
echo ""

HOME="$QC_HOME" "$WORK/rustdesk.AppImage"
`;
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
