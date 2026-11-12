/* eslint-disable no-useless-escape --
 * The installer templates in this file are shell scripts living inside JS
 * template literals, and they write `\$` for every shell variable. 81 of those
 * sites are `\${...}`, where the backslash is REQUIRED — drop it and the shell
 * variable silently becomes a JavaScript interpolation. Writing the remainder
 * as a bare `$` would leave both forms mixed in one script, which is precisely
 * the confusion that produces that bug.
 *
 * The escape that DID bite here was `\U` in `C:\Users`: a template literal
 * turns it into a bare `U`, so the generated script read `C:UsersDefault`.
 * That class of mistake is guarded by an assertion instead — see
 * scripts/security-regression.mjs, which fetches every generated installer and
 * fails if a Windows path lost its separator.
 */
import { BadRequestException, Controller, Get, Param, Query, Res, Req } from '@nestjs/common';
import { Response, Request } from 'express';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { RUSTDESK_FALLBACK_VERSION, rustdeskAssetSha256 } from '../common/rustdesk-release';
import { RustdeskService } from '../common/rustdesk.service';
import { UpdateRolloutService } from '../admin/update-rollout.service';
import { PublicUrlService } from '../platform/public-url.service';
import { buildLegacyWindowsScript } from './windows-script';
import {
  buildLinuxAgentScript, LINUX_AGENT_CONF, LINUX_AGENT_HEREDOC, LINUX_AGENT_PATH, LINUX_AGENT_SECRET,
  LINUX_AGENT_SERVICE, LINUX_AGENT_TIMER,
} from './linux-agent';
import {
  buildMacosAgentScript, MACOS_AGENT_CONF, MACOS_AGENT_DIR, MACOS_AGENT_HEREDOC, MACOS_AGENT_LABEL, MACOS_AGENT_LAUNCHD_PLIST,
  MACOS_AGENT_LOG, MACOS_AGENT_NEWSYSLOG, MACOS_AGENT_NEWSYSLOG_CONF, MACOS_AGENT_PATH, MACOS_AGENT_PLIST, MACOS_AGENT_SECRET,
} from './macos-agent';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { AgentMigrationService } from '../update-trust/agent-migration.service';
import { buildMigrationScript, validPortalHost } from '../update-trust/agent-migration';

const INSTALLER_MAGIC = Buffer.from('REM0TE_INST_URL:');
const INSTALLER_SLOT_SIZE = 256;

// Strict allowlists for values interpolated into generated shell / PowerShell scripts.
// A hostile or corrupted platform setting must never be able to break out of a quoted
// string and inject arbitrary shell commands into the customer-run installer.
const HOSTNAME_RE = /^[a-zA-Z0-9._-]{1,253}$/;
const BASE64_RE = /^[A-Za-z0-9+/]{16,512}={0,2}$/;
const HEX_TOKEN_RE = /^[A-Fa-f0-9]{16,128}$/;
const VERSION_RE = /^[a-zA-Z0-9._+-]{1,32}$/;

// What a legacy agent's heartbeat gets from windows.ps1 in signed_only mode
// when portal-mediated migration is off. It runs as SYSTEM and does nothing.
const SIGNED_ONLY_REFUSAL = `# Rem0te: this portal installs and updates only through the signed agent.
# Migrate this machine with rem0te-agent.exe (docs/update-signing.md), or
# download the installer from the portal again.
Write-Output 'Refused: signed-only update policy. Nothing was changed.'
exit 1
`;

// The one-time migration script (buildMigrationScript) lives in
// update-trust/agent-migration.ts, shared with the per-computer migration (0.34).

function safeHost(host: string | null): string {
  if (!host) return '';
  if (!HOSTNAME_RE.test(host)) throw new BadRequestException('Server relay host is not a valid hostname');
  return host;
}
function safeKey(key: string | null): string {
  if (!key) return '';
  if (!BASE64_RE.test(key)) throw new BadRequestException('Server public key is not a valid base64 value');
  return key;
}
function safeToken(token: string | undefined): string {
  if (!token) return '';
  if (!HEX_TOKEN_RE.test(token)) throw new BadRequestException('Enrollment token is not a valid hex value');
  return token;
}
function safeVersion(version: string): string {
  if (!VERSION_RE.test(version)) return RUSTDESK_FALLBACK_VERSION;
  return version;
}

@Controller('public')
export class PublicController {
  private readonly projectRoot = process.env.PROJECT_ROOT ?? path.join(process.cwd(), '..', '..');
  private readonly versionFile =
    process.env.VERSION_FILE ?? path.join(this.projectRoot, 'version.json');

  /**
   * The platform version to bake into a generated installer.
   *
   * Read per request rather than cached at construction: an in-app update
   * rewrites version.json and restarts the units, but a cache here would also
   * have to survive someone editing that file by hand, and a file read on an
   * installer download is free next to the ~40 MB the endpoint is about to
   * pull. `safeVersion`'s allowlist applies — this value is interpolated into
   * a PowerShell string literal.
   */
  private agentVersion(): string {
    try {
      const v = JSON.parse(fs.readFileSync(this.versionFile, 'utf8')) as { version?: string };
      return v.version && VERSION_RE.test(v.version) ? v.version : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly rustdesk: RustdeskService,
    private readonly rollouts: UpdateRolloutService,
    private readonly urls: PublicUrlService,
    private readonly updateTrust: UpdateTrustService,
    private readonly agentMigration: AgentMigrationService,
  ) {}

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async getSettings() {
    const settings = await this.prisma.tenantSettings.findFirst({
      select: {
        rustdeskRelayHost: true,
        rustdeskRelayPort: true,
        rustdeskPublicKey: true,
        showDownloadPage: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return settings;
  }

  private async getBranding() {
    return this.prisma.tenantBranding.findFirst({
      select: {
        portalTitle: true,
        logoUrl: true,
        accentColor: true,
        supportEmail: true,
        supportPhone: true,
        footerText: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private buildConfigString(host: string, key: string | null): string {
    return Buffer.from(JSON.stringify({ host, relay: host, key: key ?? '', api: '' })).toString('base64');
  }


  // ── Public config ─────────────────────────────────────────────────────────

  @Get('rustdesk-config')
  @Public()
  async getRustdeskConfig() {
    const [settings, branding] = await Promise.all([this.getSettings(), this.getBranding()]);
    const host = settings?.rustdeskRelayHost ?? null;
    const key = settings?.rustdeskPublicKey ?? null;
    const port = settings?.rustdeskRelayPort ?? null;
    const configString = host ? this.buildConfigString(host, key) : null;

    return {
      success: true,
      data: {
        relayHost: host,
        relayPort: port,
        publicKey: key,
        configString,
        configured: !!host,
        showDownloadPage: settings?.showDownloadPage ?? true,
        branding: branding ?? null,
      },
    };
  }

  // ── Install scripts ───────────────────────────────────────────────────────

  /**
   * Dynamically generated installer scripts.
   * GET /public/install/windows.ps1
   * GET /public/install/linux.sh
   * GET /public/install/macos.sh
   * No auth required — safe because they only embed public server settings.
   */
  // Cleaner managed-install URL: /api/v1/public/install/win/<opaque-token>
  // The token is in the path so it doesn't appear in query-string logs / Referer
  // headers, and the URL fits the pattern the Add-Computer UI hands out.
  @Get('install/win/:token')
  @Public()
  async getWindowsInstallScript(
    @Param('token') token: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    return this.getInstallScript('windows.ps1', token, res, req);
  }
  @Get('install/linux/:token')
  @Public()
  async getLinuxInstallScript(
    @Param('token') token: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    return this.getInstallScript('linux.sh', token, res, req);
  }
  @Get('install/mac/:token')
  @Public()
  async getMacInstallScript(
    @Param('token') token: string,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    return this.getInstallScript('macos.sh', token, res, req);
  }

  /**
   * Parameters for the signed installer (0.24): data, never code. The signed
   * agent fetches these, validates every field, and passes them to the signed
   * `windows/install.ps1` in a file. The relay host and key here are used on
   * first install only; an installed agent keeps the relay it pinned.
   *
   * The RustDesk version is the platform pin or latest — or, for a staged
   * rollout job, exactly that job's version — and only ever a version the
   * release signer published: the agent refuses anything else anyway.
   */
  @Get('install/windows-params.json')
  @Public()
  async windowsParams(@Query('updateNonce') updateNonce: string | undefined, @Res() res: Response) {
    const settings = await this.getSettings();
    const host = settings?.rustdeskRelayHost ?? null;
    const key = settings?.rustdeskPublicKey ?? null;
    if (!host || !key || !HOSTNAME_RE.test(host) || !BASE64_RE.test(key)) {
      res.status(503).json({ success: false, code: 'RELAY_NOT_CONFIGURED', message: 'The relay host and key are not configured.' });
      return;
    }
    const signed = this.updateTrust.signedRustdeskVersions();
    let version = await this.rustdesk.pinnedOrLatestVersion();
    let nonce = '';
    if (updateNonce && /^[A-Za-z0-9_-]{16,64}$/.test(updateNonce)) {
      const job = await this.rollouts.installerFetched(updateNonce);
      if (job) {
        nonce = updateNonce;
        if (job.component === 'RUSTDESK') version = job.version;
      }
    }
    if (!nonce && !signed.includes(version) && signed.length) version = signed[0];
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, data: { schema: 'rem0te-install-params/1', host, key, rustdeskVersion: version, ...(nonce ? { updateNonce: nonce } : {}) } });
  }

  /** GET /public/install/rem0te-tray.exe — the bytes whose SHA-256 the served script pins. Before install/:platform, which would match it. */
  @Get('install/rem0te-tray.exe')
  @Public()
  async trayDownload(@Res() res: Response) {
    const t = this.trayExe();
    if (!t) { res.status(404).json({ success: false, message: 'This portal has no tray build.' }); return; }
    const bytes = await fs.promises.readFile(t.path);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="rem0te-tray.exe"');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-SHA256', t.sha256);
    res.send(bytes);
  }

  @Get('install/:platform')
  @Public()
  async getInstallScript(
    @Param('platform') platform: string,
    @Query('token') enrollToken: string | undefined,
    @Res() res: Response,
    @Req() req: Request,
    @Query('updateNonce') updateNonce?: string,
  ) {
    const settings = await this.getSettings();
    const host = settings?.rustdeskRelayHost ?? null;
    const key = settings?.rustdeskPublicKey ?? null;
    // The platform pin if one is set, else the latest release — and for an
    // installer fetched for a rollout job, exactly that rollout's approved
    // version and digest. The nonce is the only input that can change the
    // version, and it names one live dispatch; an unknown nonce changes
    // nothing. The version is never taken from the query string.
    let version = await this.rustdesk.pinnedOrLatestVersion();
    let pinnedSha: string | null | undefined;
    let jobNonce: string | null = null;
    if (platform === 'windows.ps1' && updateNonce) {
      const job = await this.rollouts.installerFetched(updateNonce);
      if (job) {
        jobNonce = updateNonce;
        if (job.component === 'RUSTDESK') { version = job.version; pinnedSha = job.sha256; }
      }
    }

    // Validate enrollment token if provided — look up by SHA-256 hash
    let validatedToken: string | undefined;
    if (enrollToken) {
      const tokenHash = createHash('sha256').update(enrollToken).digest('hex');
      const tokenRecord = await this.prisma.deviceClaimToken.findUnique({ where: { token: tokenHash } });
      if (tokenRecord && !tokenRecord.claimedAt && tokenRecord.expiresAt >= new Date()) {
        validatedToken = enrollToken;
      }
    }

    let script: string;
    let contentType: string;
    let filename: string;

    if (platform === 'windows.ps1') {
      // One computer's migration to the signed agent (0.34): the heartbeat
      // handed exactly that computer this nonce. Its script is the same one
      // the mode below serves, pinned to the served signed agent's digest; a
      // nonce that is not an open migration changes nothing.
      if (updateNonce && !jobNonce) {
        const mig = await this.agentMigration.scriptForNonce(updateNonce);
        if (mig !== null) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Content-Disposition', 'inline; filename="install-rustdesk.ps1"');
          res.setHeader('Cache-Control', 'no-store');
          res.send(mig);
          return;
        }
      }
      // Containment (0.24). This route is what every legacy agent's heartbeat
      // pipes into a SYSTEM PowerShell. In signed_only it serves no installer:
      // either the one-time migration to the signed agent (when an operator
      // has allowed portal-mediated migration) or a refusal.
      const trustMode = await this.updateTrust.mode();
      if (trustMode.mode === 'signed_only') {
        const agentT = this.updateTrust.agentTarget();
        const portalHost = this.portalHostFor(req, host);
        script = trustMode.legacyPortalMigration && agentT && portalHost
          ? buildMigrationScript(portalHost, agentT.sha256)
          : SIGNED_ONLY_REFUSAL;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="install-rustdesk.ps1"');
        res.setHeader('Cache-Control', 'no-store');
        res.send(script);
        return;
      }
      const sha = pinnedSha !== undefined ? pinnedSha : await rustdeskAssetSha256(version, `rustdesk-${version}-x86_64.exe`);
      script = this.buildWindowsScript(version, host, key, validatedToken, sha, jobNonce);
      contentType = 'text/plain; charset=utf-8';
      filename = 'install-rustdesk.ps1';
    } else if (platform === 'linux.sh') {
      script = this.buildLinuxScript(version, host, key, validatedToken);
      contentType = 'text/plain; charset=utf-8';
      filename = 'install-rustdesk.sh';
    } else if (platform === 'macos.sh') {
      script = this.buildMacosScript(version, host, key, validatedToken);
      contentType = 'text/plain; charset=utf-8';
      filename = 'install-rustdesk-macos.sh';
    } else if (platform === 'windows.exe') {
      // Prefer the configured public address (setting, then PUBLIC_API_URL) over
      // spoofable request headers. Falling back to headers only if neither is set. The URL is embedded inside the
      // installer and controls where the customer's machine fetches the PowerShell
      // script from, so header trust is a supply-chain risk.
      const configuredBase = this.urls.apiConfigured() ?? undefined;
      // https only outside development: this URL is baked into an installer that
      // pipes whatever it fetches into an elevated PowerShell, so plaintext here
      // is a root shell for anyone on the path. The installer binary refuses a
      // non-https slot as well.
      const schemeOk = process.env.NODE_ENV === 'production'
        ? /^https:\/\/[a-zA-Z0-9.:_-]+/
        : /^https?:\/\/[a-zA-Z0-9.:_-]+/;
      let apiUrl: string;
      if (configuredBase && schemeOk.test(configuredBase)) {
        apiUrl = configuredBase;
      } else {
        const proto = process.env.NODE_ENV === 'production'
          ? 'https'
          : ((req.headers['x-forwarded-proto'] as string | undefined) ?? 'https');
        const reqHost = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
        if (!HOSTNAME_RE.test(String(reqHost).replace(/:.*$/, ''))) {
          res.status(400).json({ success: false, message: 'Invalid host' });
          return;
        }
        apiUrl = `${proto}://${reqHost}`;
      }
      const tokenSuffix = validatedToken ? `?token=${encodeURIComponent(validatedToken)}` : '';
      const psUrl = `${apiUrl}/api/v1/public/install/windows.ps1${tokenSuffix}`;
      await this.serveWindowsExe(psUrl, res);
      return;
    } else {
      res.status(404).json({ success: false, message: 'Unknown platform' });
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  }

  // ── Script templates ──────────────────────────────────────────────────────

  // The template lives in ./windows-script.ts, shared with the signed build
  // (`windows/install.ps1`) so the two variants cannot drift apart.
  private buildWindowsScript(
    version: string, host: string | null, key: string | null, enrollToken?: string, clientSha256?: string | null,
    updateNonce?: string | null,
  ): string {
    // Validated here first so a bad setting is a 400, not a 500.
    safeHost(host); safeKey(key); safeToken(enrollToken);
    return buildLegacyWindowsScript({
      version: safeVersion(version), host, key, enrollToken, clientSha256, updateNonce,
      agentVersion: this.agentVersion(), fallbackVersion: RUSTDESK_FALLBACK_VERSION,
      traySha256: this.trayExe()?.sha256 ?? null,
    });
  }

  /**
   * The tray (0.36) the standard agent's installer downloads: the signed
   * release's windows/rem0te-tray.exe when the repository has one (the same
   * bytes the signed agent verifies), else dist/rem0te-tray.exe. The script
   * pins the SHA-256 computed here, so what the installer accepts is exactly
   * what this route serves. Hashed once per file version.
   */
  private trayCache: { path: string; mtimeMs: number; size: number; sha256: string } | null = null;
  private trayExe(): { path: string; sha256: string } | null {
    const p = this.updateTrust.trayTarget()?.path ?? path.join(this.projectRoot, 'dist', 'rem0te-tray.exe');
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size === 0 || st.size > 64 * 1024 * 1024) return null;
      if (this.trayCache && this.trayCache.path === p && this.trayCache.mtimeMs === st.mtimeMs && this.trayCache.size === st.size) return this.trayCache;
      const sha256 = createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      this.trayCache = { path: p, mtimeMs: st.mtimeMs, size: st.size, sha256 };
      return this.trayCache;
    } catch {
      return null;
    }
  }


  // Which address a migration script tells the agent to use: the configured
  // public address when there is one, otherwise the relay host (which is what
  // the legacy heartbeat already talks to). Never a request header.
  private portalHostFor(_req: Request, relayHost: string | null): string | null {
    const configured = this.urls.apiConfigured();
    if (configured) {
      try {
        const u = new URL(configured);
        if (u.protocol === 'https:' && validPortalHost(u.host)) return u.host;
      } catch { /* fall through */ }
    }
    return relayHost && HOSTNAME_RE.test(relayHost) ? relayHost : null;
  }

  private async serveWindowsExe(psUrl: string, res: Response): Promise<void> {
    // With a signed repository, the download is the signed agent binary
    // itself (the same bytes as target windows/rem0te-agent.exe, slot aside),
    // which verifies everything it installs. Without one, the legacy
    // bootstrap from dist/ — and in signed_only there is no legacy bootstrap.
    const agentT = this.updateTrust.agentTarget();
    if (!agentT && (await this.updateTrust.mode()).mode === 'signed_only') {
      res.status(503).json({ success: false, code: 'SIGNED_AGENT_UNAVAILABLE', message: 'This portal installs only the signed agent, and the update repository has no windows/rem0te-agent.exe target.' });
      return;
    }
    const exePath = agentT?.path ?? path.join(this.projectRoot, 'dist', 'windows-installer.exe');
    let binary: Buffer;
    try {
      binary = await fs.promises.readFile(exePath);
    } catch {
      res.status(503).json({ success: false, message: 'Windows installer binary not available' });
      return;
    }

    const idx = binary.indexOf(INSTALLER_MAGIC);
    if (idx === -1) {
      res.status(500).json({ success: false, message: 'Installer binary is corrupt (magic not found)' });
      return;
    }

    // Patch: zero the URL field then write the new URL (null-terminated)
    const patched = Buffer.from(binary);
    const urlStart = idx + INSTALLER_MAGIC.length;
    const urlEnd = idx + INSTALLER_SLOT_SIZE;
    patched.fill(0, urlStart, urlEnd);
    const urlBytes = Buffer.from(psUrl, 'utf8');
    urlBytes.copy(patched, urlStart, 0, Math.min(urlBytes.length, urlEnd - urlStart - 1));

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="install-reboot-remote.exe"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(patched);
  }

  private buildLinuxScript(version: string, host: string | null, key: string | null, enrollToken?: string): string {
    const hostVal = safeHost(host);
    const keyVal = safeKey(key);
    const claimToken = safeToken(enrollToken);
    version = safeVersion(version);
    const agentScript = buildLinuxAgentScript(this.agentVersion());
    if (agentScript.split('\n').includes(LINUX_AGENT_HEREDOC)) throw new Error('agent script contains its heredoc delimiter');
    return `#!/usr/bin/env bash
# Reboot Remote — RustDesk Auto-Installer for Linux (Debian/Ubuntu)
# Server: ${host ?? 'NOT CONFIGURED'}
# Re-run this script at any time to update the server config.
#
# Installs RustDesk, registers this computer, and installs the Rem0te agent
# (standard, read-only): ${LINUX_AGENT_PATH}, run every 3 minutes by
# rem0te-agent.timer. It reports inventory and pending updates and never acts
# on anything the server sends.
#
# Remove the agent (timer, script, config and device secret; RustDesk stays):
#   curl -fsSL <this installer's URL> | sudo bash -s -- --uninstall
set -euo pipefail

if [ "\${1:-}" = "--uninstall" ]; then
  [ "$EUID" -eq 0 ] || { echo "ERROR: Run as root: sudo bash -s -- --uninstall"; exit 1; }
  systemctl disable --now rem0te-agent.timer 2>/dev/null || true
  systemctl stop rem0te-agent.service 2>/dev/null || true
  rm -f /etc/systemd/system/rem0te-agent.timer /etc/systemd/system/rem0te-agent.service
  systemctl daemon-reload 2>/dev/null || true
  rm -f ${LINUX_AGENT_PATH} ${LINUX_AGENT_CONF} ${LINUX_AGENT_SECRET}
  rmdir /usr/local/lib/rem0te 2>/dev/null || true
  echo "Removed the Rem0te agent: the timer, ${LINUX_AGENT_PATH}, ${LINUX_AGENT_CONF} and the device secret."
  echo "RustDesk is still installed (remove it with: apt remove rustdesk)."
  echo "Archive the computer in Rem0te too; re-installing later needs a new enrolment link."
  exit 0
fi

VERSION="${version}"
HOST_ADDR="${hostVal}"
PUB_KEY="${keyVal}"
CLAIM_TOKEN="${claimToken}"

RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; CYAN='\\033[0;36m'; NC='\\033[0m'

# Root first: the device secret below is written to /etc, and a non-root run
# used to carry on without it and register a machine its agent could never
# authenticate as.
[ "$EUID" -eq 0 ] || { echo -e "\${RED}ERROR: Run as root: sudo bash\${NC}"; exit 1; }

# Generate a permanent password for this device. "|| true": head exits after
# 12 bytes, tr dies of SIGPIPE (141), and under pipefail that status would end
# the installer here, silently (0.33).
PERM_PW=$(LC_ALL=C tr -dc 'A-Za-z2-9' < /dev/urandom | head -c 12 || true)

# Device secret: what proves to the server that a later call really is this
# machine. The RustDesk ID alone used to be enough, and it is a number anyone
# who has connected here knows. Kept 0600 and reused across re-installs so the
# binding the server holds stays valid.
AGENT_STATE="${LINUX_AGENT_SECRET}"
if [ -r "\${AGENT_STATE}" ]; then
  AGENT_SECRET=$(cat "\${AGENT_STATE}" 2>/dev/null | tr -dc 'A-Za-z0-9_-')
else
  AGENT_SECRET=""
fi
if [ -z "\${AGENT_SECRET}" ]; then
  AGENT_SECRET=$(LC_ALL=C tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c 43 || true)
  ( umask 077; printf '%s' "\${AGENT_SECRET}" > "\${AGENT_STATE}" ) 2>/dev/null || true
fi
chown root:root "\${AGENT_STATE}" 2>/dev/null || true
chmod 600 "\${AGENT_STATE}" 2>/dev/null || { echo -e "\${RED}ERROR: could not write the device secret \${AGENT_STATE}\${NC}"; exit 1; }

echo -e "\${CYAN}"
echo "  Reboot Remote — Installing RustDesk remote support client"
echo -e "\${NC}"

ARCH="x86_64"
[ "$(uname -m)" = "aarch64" ] && ARCH="aarch64"

DEB_URL="https://github.com/rustdesk/rustdesk/releases/download/\${VERSION}/rustdesk-\${VERSION}-\${ARCH}.deb"
TMP_DEB="/tmp/rustdesk-install.deb"

echo -e "\${YELLOW}[1/4] Downloading RustDesk v\${VERSION}...\${NC}"
curl -fsSL -o "\${TMP_DEB}" "\${DEB_URL}"

# Stop existing service BEFORE installing/configuring so it can't overwrite our config
echo -e "\${YELLOW}[2/4] Stopping existing RustDesk (if running)...\${NC}"
systemctl stop rustdesk 2>/dev/null || true
pkill -f rustdesk 2>/dev/null || true
sleep 1

echo "     Installing package..."
dpkg -i "\${TMP_DEB}" 2>/dev/null || apt-get -f install -y -qq
rm -f "\${TMP_DEB}"

echo -e "\${YELLOW}[3/4] Writing server config (overwrites any existing config)...\${NC}"

TOML_CONTENT="rendezvous_server = '\${HOST_ADDR}:21116'
nat_type = 1
serial = 2

[options]
custom-rendezvous-server = '\${HOST_ADDR}'
relay-server = '\${HOST_ADDR}'
api-server = ''
key = '\${PUB_KEY}'
verification-method = 'use-permanent-password'"

# Write to all known config locations
for CFG_DIR in \\
    "/root/.config/rustdesk" \\
    "/home/\$(logname 2>/dev/null || echo nobody)/.config/rustdesk" \\
    "/var/lib/rustdesk" \\
    "/etc/rustdesk"; do
  mkdir -p "\${CFG_DIR}" 2>/dev/null || true
  printf '%s\\n' "\${TOML_CONTENT}" > "\${CFG_DIR}/RustDesk2.toml" && \\
    echo "  Wrote: \${CFG_DIR}/RustDesk2.toml" || true
done

echo -e "\${YELLOW}[4/4] Setting permanent password and starting service...\${NC}"

# Set the permanent password BEFORE starting the service so it is in the config
# on first read. Running this with the service stopped writes directly to the file.
rustdesk --password "\${PERM_PW}" 2>/dev/null || true
sleep 1

systemctl enable rustdesk 2>/dev/null || true
systemctl restart rustdesk 2>/dev/null || true

# Wait up to 45 s for RustDesk to receive its ID from hbbs
echo "     Waiting for RustDesk to receive Device ID from server..."
RD_ID=""
WAITED=0
while [ -z "\${RD_ID}" ] && [ \${WAITED} -lt 45 ]; do
  sleep 3
  WAITED=\$((WAITED + 3))
  for CFG_FILE in "/root/.config/rustdesk/RustDesk.toml" \\
                  "/root/.config/rustdesk/RustDesk2.toml" \\
                  "/var/lib/rustdesk/RustDesk.toml" \\
                  "/var/lib/rustdesk/RustDesk2.toml"; do
    if [ -f "\${CFG_FILE}" ]; then
      # Match: id = '123456789'  or  id = "123456789"
      CAND=\$(grep -E "^[[:space:]]*id[[:space:]]*=" "\${CFG_FILE}" 2>/dev/null | head -1 | sed -E "s/.*['\\"]([0-9]{6,15})['\\"].*/\\1/" | head -1)
      if echo "\${CAND}" | grep -qE '^[0-9]{6,15}$'; then
        RD_ID="\${CAND}"
        break
      fi
    fi
  done
done

HOSTNAME_SHORT=\$(hostname -s 2>/dev/null || echo unknown)

# Always register — claim if token present, else heartbeat as unassigned.
if [ -n "\${RD_ID}" ]; then
  if [ -n "\${CLAIM_TOKEN}" ]; then
    echo "  Registering device with Rem0te (claim token supplied)..."
    if ! curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/claim" \\
      -H "Content-Type: application/json" \\
      -d "{\\"token\\":\\"\${CLAIM_TOKEN}\\",\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"linux\\",\\"password\\":\\"\${PERM_PW}\\",\\"agentSecret\\":\\"\${AGENT_SECRET}\\"}" >/dev/null; then
      echo "  Claim failed — falling back to unassigned registration."
      curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/heartbeat" \\
        -H "Content-Type: application/json" \\
        -d "{\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"linux\\",\\"password\\":\\"\${PERM_PW}\\",\\"agentSecret\\":\\"\${AGENT_SECRET}\\"}" >/dev/null || true
    else
      echo "  Device registered to its business."
    fi
  else
    echo "  Registering device with Rem0te (no claim token — will appear as Unassigned)..."
    curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/heartbeat" \\
      -H "Content-Type: application/json" \\
      -d "{\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"linux\\",\\"password\\":\\"\${PERM_PW}\\",\\"agentSecret\\":\\"\${AGENT_SECRET}\\"}" >/dev/null || true
    echo "  Device registered. Assign it under Admin -> Unassigned Devices."
  fi
else
  echo "  Could not detect RustDesk Device ID after 45 s — skipping registration."
fi

# ── The Rem0te agent (standard, read-only) ──────────────────────────────────
# Heartbeat, inventory and pending updates every 3 minutes, authenticated with
# the device secret above. Installed even when registration was skipped: it
# finds the RustDesk ID once RustDesk has one. It reads; it runs nothing the
# server sends.
if [ -n "\${HOST_ADDR}" ] && command -v systemctl >/dev/null 2>&1; then
  echo "  Installing the Rem0te agent (heartbeat and inventory, every 3 minutes)..."
  install -d -m 0755 -o root -g root /usr/local/lib/rem0te
  AGENT_TMP=$(mktemp)
  cat > "\${AGENT_TMP}" <<'${LINUX_AGENT_HEREDOC}'
${agentScript}${LINUX_AGENT_HEREDOC}
  install -m 0755 -o root -g root "\${AGENT_TMP}" ${LINUX_AGENT_PATH}
  rm -f "\${AGENT_TMP}"
  ( umask 022; printf 'API_BASE=https://%s/api/v1\\n' "\${HOST_ADDR}" > ${LINUX_AGENT_CONF} )
  cat > /etc/systemd/system/rem0te-agent.service <<'REM0TE_UNIT_EOF'
${LINUX_AGENT_SERVICE}REM0TE_UNIT_EOF
  cat > /etc/systemd/system/rem0te-agent.timer <<'REM0TE_UNIT_EOF'
${LINUX_AGENT_TIMER}REM0TE_UNIT_EOF
  chmod 644 /etc/systemd/system/rem0te-agent.service /etc/systemd/system/rem0te-agent.timer
  systemctl daemon-reload
  systemctl enable --now rem0te-agent.timer >/dev/null 2>&1 || echo -e "\${YELLOW}  Could not start rem0te-agent.timer — see: systemctl status rem0te-agent.timer\${NC}"
  # First report now rather than in two minutes; its result is in the journal.
  systemctl start --no-block rem0te-agent.service 2>/dev/null || true
  echo "  Agent installed: ${LINUX_AGENT_PATH} (logs: journalctl -u rem0te-agent)"
else
  echo -e "\${YELLOW}  Rem0te agent not installed: \${HOST_ADDR:+systemd not found}\${HOST_ADDR:-the server address is not configured}.\${NC}"
fi

echo ""
echo -e "\${GREEN}=============================================\${NC}"
echo -e "\${GREEN}  RustDesk installed and running as service!\${NC}"
echo -e "\${GREEN}=============================================\${NC}"
if [ -n "\${RD_ID}" ]; then
  echo -e "\${CYAN}  Device ID:          \${RD_ID}\${NC}"
  echo -e "\${CYAN}  Permanent password: \${PERM_PW}\${NC}"
  echo ""
  echo -e "\${YELLOW}  IMPORTANT: Save this password in your remote management portal.\${NC}"
  echo -e "\${YELLOW}  The one-time rotating password has been DISABLED on this device.\${NC}"
fi
[ -n "\${HOST_ADDR}" ] && echo "  Connected to server: \${HOST_ADDR}"
echo ""
echo "  The service starts automatically on boot."
echo "  Re-run this script at any time to update server settings."
echo ""
`;
  }

  private buildMacosScript(version: string, host: string | null, key: string | null, enrollToken?: string): string {
    const hostVal = safeHost(host);
    const keyVal = safeKey(key);
    const claimToken = safeToken(enrollToken);
    version = safeVersion(version);
    const agentScript = buildMacosAgentScript(this.agentVersion());
    if (agentScript.split('\n').includes(MACOS_AGENT_HEREDOC)) throw new Error('agent script contains its heredoc delimiter');
    return `#!/usr/bin/env bash
# Reboot Remote — RustDesk Auto-Installer for macOS
# Server: ${host ?? 'NOT CONFIGURED'}
# Re-run this script at any time to update the server config.
#
# Run with sudo (as Devices -> Add device shows it), this also installs the
# Rem0te agent (standard, read-only): ${MACOS_AGENT_PATH}, run every 3 minutes
# by the ${MACOS_AGENT_LABEL} LaunchDaemon. It reports inventory and pending
# updates and never acts on anything the server sends. Without sudo it
# installs RustDesk and registers the computer only, as before 0.33.
#
# Remove the agent (daemon, script, config, log and device secret; RustDesk stays):
#   curl -fsSL <this installer's URL> | sudo bash -s -- --uninstall
set -euo pipefail

if [ "\${1:-}" = "--uninstall" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "ERROR: Run as root: sudo bash -s -- --uninstall"; exit 1; }
  launchctl bootout system/${MACOS_AGENT_LABEL} 2>/dev/null || launchctl unload ${MACOS_AGENT_PLIST} 2>/dev/null || true
  rm -f ${MACOS_AGENT_PLIST} ${MACOS_AGENT_NEWSYSLOG}
  rm -f ${MACOS_AGENT_PATH} ${MACOS_AGENT_CONF} ${MACOS_AGENT_SECRET}
  rm -f ${MACOS_AGENT_LOG} ${MACOS_AGENT_LOG}.*
  rmdir ${MACOS_AGENT_DIR} 2>/dev/null || true
  echo "Removed the Rem0te agent: the LaunchDaemon, ${MACOS_AGENT_PATH}, ${MACOS_AGENT_CONF}, its log and the device secret."
  echo "RustDesk is still installed (remove it by deleting /Applications/RustDesk.app)."
  echo "Archive the computer in Rem0te too; re-installing later needs a new enrolment link."
  exit 0
fi

VERSION="${version}"
HOST_ADDR="${hostVal}"
PUB_KEY="${keyVal}"
CLAIM_TOKEN="${claimToken}"

IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then IS_ROOT=1; fi

# Generate a permanent password for this device. "|| true": head exits after
# 12 bytes, tr dies of SIGPIPE (141), and under pipefail that status would end
# the installer here, silently (0.33).
PERM_PW=$(LC_ALL=C tr -dc 'A-Za-z2-9' < /dev/urandom | head -c 12 || true)

# Device secret — see the Linux installer for why the RustDesk ID is not
# identity. Reused across re-installs so the binding the server holds stays
# valid.
if [ "\${IS_ROOT}" = 1 ]; then
  # As root (0.33): root-only, ${MACOS_AGENT_SECRET}, which the agent refuses
  # unless it is 0600 and owned by root.
  AGENT_STATE="${MACOS_AGENT_SECRET}"
  install -d -m 0755 -o root -g wheel ${MACOS_AGENT_DIR}
  AGENT_SECRET=""
  if [ -f "\${AGENT_STATE}" ] && [ ! -L "\${AGENT_STATE}" ]; then
    AGENT_SECRET=$(tr -dc 'A-Za-z0-9_-' < "\${AGENT_STATE}" 2>/dev/null || true)
  fi
  # Before 0.33 the secret was kept in the home directory of whoever ran this.
  # Keep it — the server holds its hash — but only from a copy root wrote
  # (owner root, mode 600, not a link): a copy a user wrote is one that user
  # knows, and could report as this computer with. Then delete every copy.
  LEGACY_SECRETS=("\${HOME}/.rem0te-agent.secret" "/var/root/.rem0te-agent.secret")
  if [ -n "\${SUDO_USER:-}" ]; then LEGACY_SECRETS+=("/Users/\${SUDO_USER}/.rem0te-agent.secret"); fi
  for f in "\${LEGACY_SECRETS[@]}"; do
    [ -f "\${f}" ] || continue
    if [ -z "\${AGENT_SECRET}" ] && [ ! -L "\${f}" ] && [ "$(stat -f '%u %Lp' "\${f}" 2>/dev/null)" = "0 600" ]; then
      AGENT_SECRET=$(tr -dc 'A-Za-z0-9_-' < "\${f}" 2>/dev/null || true)
    fi
    rm -f "\${f}"
  done
  if [ -z "\${AGENT_SECRET}" ]; then
    AGENT_SECRET=$(LC_ALL=C tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c 43 || true)
  fi
  rm -f "\${AGENT_STATE}"
  ( umask 077; printf '%s' "\${AGENT_SECRET}" > "\${AGENT_STATE}" )
  chown root:wheel "\${AGENT_STATE}"
  chmod 600 "\${AGENT_STATE}" || { echo "ERROR: could not write the device secret \${AGENT_STATE}"; exit 1; }
else
  # Without sudo: under the user's home, 0600, as before 0.33. No agent is
  # installed in this case, so nothing reads it after the claim.
  AGENT_STATE="\${HOME}/.rem0te-agent.secret"
  if [ -r "\${AGENT_STATE}" ]; then
    AGENT_SECRET=$(cat "\${AGENT_STATE}" 2>/dev/null | tr -dc 'A-Za-z0-9_-')
  else
    AGENT_SECRET=""
  fi
  if [ -z "\${AGENT_SECRET}" ]; then
    AGENT_SECRET=$(LC_ALL=C tr -dc 'A-Za-z0-9_-' < /dev/urandom | head -c 43 || true)
    ( umask 077; printf '%s' "\${AGENT_SECRET}" > "\${AGENT_STATE}" ) 2>/dev/null || true
  fi
fi

ARCH=$(uname -m)
[ "$ARCH" = "arm64" ] && DMGFILE="rustdesk-\${VERSION}-aarch64.dmg" || DMGFILE="rustdesk-\${VERSION}-x86_64.dmg"
DMG_URL="https://github.com/rustdesk/rustdesk/releases/download/\${VERSION}/\${DMGFILE}"
TMP_DMG="/tmp/rustdesk.dmg"
RDAPP="/Applications/RustDesk.app"

echo ""
echo "  Reboot Remote — Installing RustDesk remote support client"
echo ""

echo "[1/3] Downloading RustDesk v\${VERSION}..."
curl -fsSL -o "\${TMP_DMG}" "\${DMG_URL}"

# Kill any running RustDesk before replacing
pkill -f RustDesk 2>/dev/null || true
sleep 1

echo "[2/3] Installing..."
hdiutil attach "\${TMP_DMG}" -quiet -nobrowse -mountpoint /Volumes/RustDesk
cp -Rf "/Volumes/RustDesk/RustDesk.app" /Applications/
hdiutil detach /Volumes/RustDesk -quiet
rm -f "\${TMP_DMG}"

if [ ! -d "\${RDAPP}" ]; then
    echo "ERROR: Installation failed — \${RDAPP} not found"
    exit 1
fi

echo "[3/3] Writing server config (overwrites any existing config)..."

TOML_CONTENT="rendezvous_server = '\${HOST_ADDR}:21116'
nat_type = 1
serial = 2

[options]
custom-rendezvous-server = '\${HOST_ADDR}'
relay-server = '\${HOST_ADDR}'
api-server = ''
key = '\${PUB_KEY}'
verification-method = 'use-permanent-password'"

# Write to all known macOS config paths
for CFG_DIR in \\
    "\${HOME}/Library/Preferences/com.carriez.RustDesk" \\
    "\${HOME}/Library/Application Support/com.carriez.RustDesk" \\
    "\${HOME}/.config/rustdesk"; do
  mkdir -p "\${CFG_DIR}" 2>/dev/null || true
  printf '%s\\n' "\${TOML_CONTENT}" > "\${CFG_DIR}/RustDesk2.toml" && \\
    echo "  Wrote: \${CFG_DIR}/RustDesk2.toml" || true
done

# Set the permanent password BEFORE launching so it is in the config on first read
"\${RDAPP}/Contents/MacOS/rustdesk" --password "\${PERM_PW}" 2>/dev/null || true
sleep 1

# Launch the app to initialize ID
open "\${RDAPP}"

# Wait up to 45 s for RustDesk to receive its ID from hbbs
echo "  Waiting for RustDesk to receive Device ID from server..."
RD_ID=""
WAITED=0
while [ -z "\${RD_ID}" ] && [ \${WAITED} -lt 45 ]; do
  sleep 3
  WAITED=\$((WAITED + 3))
  for CFG in "\${HOME}/Library/Preferences/com.carriez.RustDesk/RustDesk.toml" \\
             "\${HOME}/Library/Preferences/com.carriez.RustDesk/RustDesk2.toml" \\
             "\${HOME}/Library/Application Support/com.carriez.RustDesk/RustDesk.toml"; do
    if [ -f "\${CFG}" ]; then
      CAND=\$(grep -E "^[[:space:]]*id[[:space:]]*=" "\${CFG}" 2>/dev/null | head -1 | sed -E "s/.*['\\"]([0-9]{6,15})['\\"].*/\\1/" | head -1)
      if echo "\${CAND}" | grep -qE '^[0-9]{6,15}$'; then
        RD_ID="\${CAND}"
        break
      fi
    fi
  done
done

HOSTNAME_SHORT=\$(hostname -s 2>/dev/null || echo unknown)

# Always register — claim if token present, else heartbeat as unassigned.
if [ -n "\${RD_ID}" ]; then
  if [ -n "\${CLAIM_TOKEN}" ]; then
    echo "  Registering device with Rem0te (claim token supplied)..."
    if ! curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/claim" \\
      -H "Content-Type: application/json" \\
      -d "{\\"token\\":\\"\${CLAIM_TOKEN}\\",\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"macos\\",\\"password\\":\\"\${PERM_PW}\\",\\"agentSecret\\":\\"\${AGENT_SECRET}\\"}" >/dev/null; then
      echo "  Claim failed — falling back to unassigned registration."
      curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/heartbeat" \\
        -H "Content-Type: application/json" \\
        -d "{\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"macos\\",\\"password\\":\\"\${PERM_PW}\\",\\"agentSecret\\":\\"\${AGENT_SECRET}\\"}" >/dev/null || true
    else
      echo "  Device registered to its business."
    fi
  else
    echo "  Registering device with Rem0te (no claim token — will appear as Unassigned)..."
    curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/heartbeat" \\
      -H "Content-Type: application/json" \\
      -d "{\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"macos\\",\\"password\\":\\"\${PERM_PW}\\",\\"agentSecret\\":\\"\${AGENT_SECRET}\\"}" >/dev/null || true
    echo "  Device registered. Assign it under Admin -> Unassigned Devices."
  fi
else
  echo "  Could not detect RustDesk Device ID after 45 s — skipping registration."
fi

# ── The Rem0te agent (standard, read-only, 0.33) ────────────────────────────
# Heartbeat, inventory and pending updates every 3 minutes, authenticated with
# the device secret above. Installed even when registration was skipped: it
# finds the RustDesk ID once RustDesk has one. It reads; it runs nothing the
# server sends. Only as root: a LaunchDaemon and a root-only secret need it.
if [ "\${IS_ROOT}" = 1 ] && [ -n "\${HOST_ADDR}" ]; then
  echo "  Installing the Rem0te agent (heartbeat and inventory, every 3 minutes)..."
  install -d -m 0755 -o root -g wheel ${MACOS_AGENT_DIR}
  AGENT_TMP=$(mktemp ${MACOS_AGENT_DIR}/.agent.XXXXXX)
  cat > "\${AGENT_TMP}" <<'${MACOS_AGENT_HEREDOC}'
${agentScript}${MACOS_AGENT_HEREDOC}
  install -m 0755 -o root -g wheel "\${AGENT_TMP}" ${MACOS_AGENT_PATH}
  rm -f "\${AGENT_TMP}"
  ( umask 022; printf 'API_BASE=https://%s/api/v1\\n' "\${HOST_ADDR}" > ${MACOS_AGENT_CONF} )
  chown root:wheel ${MACOS_AGENT_CONF}
  cat > ${MACOS_AGENT_PLIST} <<'REM0TE_PLIST_EOF'
${MACOS_AGENT_LAUNCHD_PLIST}REM0TE_PLIST_EOF
  chown root:wheel ${MACOS_AGENT_PLIST}
  chmod 644 ${MACOS_AGENT_PLIST}
  mkdir -p /etc/newsyslog.d
  cat > ${MACOS_AGENT_NEWSYSLOG} <<'REM0TE_PLIST_EOF'
${MACOS_AGENT_NEWSYSLOG_CONF}REM0TE_PLIST_EOF
  chmod 644 ${MACOS_AGENT_NEWSYSLOG}
  # Reload: a re-run replaces the script and the job. RunAtLoad makes the
  # first report now rather than in three minutes.
  launchctl bootout system/${MACOS_AGENT_LABEL} 2>/dev/null || true
  launchctl enable system/${MACOS_AGENT_LABEL} 2>/dev/null || true
  if launchctl bootstrap system ${MACOS_AGENT_PLIST} 2>/dev/null || launchctl load -w ${MACOS_AGENT_PLIST} 2>/dev/null; then
    echo "  Agent installed: ${MACOS_AGENT_PATH} (log: ${MACOS_AGENT_LOG})"
  else
    echo "  Could not load the LaunchDaemon — see: sudo launchctl print system/${MACOS_AGENT_LABEL}"
  fi
elif [ "\${IS_ROOT}" != 1 ]; then
  echo "  Rem0te agent not installed: re-run this installer with sudo to add heartbeat, inventory and pending updates."
else
  echo "  Rem0te agent not installed: the server address is not configured."
fi

echo ""
echo "============================================="
echo "  RustDesk installed and configured!"
echo "============================================="
if [ -n "\${RD_ID}" ]; then
  echo "  Device ID:          \${RD_ID}"
  echo "  Permanent password: \${PERM_PW}"
  echo ""
  echo "  IMPORTANT: Save this password in your remote management portal."
  echo "  The one-time rotating password has been DISABLED on this device."
fi
[ -n "\${HOST_ADDR}" ] && echo "  Connected to server: \${HOST_ADDR}"
echo ""
echo "  Note: On macOS, RustDesk does not auto-start as a system service."
echo "  Enable 'Start on Login' in RustDesk settings for permanent access."
echo "  Re-run this script at any time to update server settings."
echo ""
`;
  }
}
