import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import * as https from 'https';

@Controller('public')
export class PublicController {
  constructor(private readonly prisma: PrismaService) {}

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

  /** Fetch the latest RustDesk release tag from GitHub (cached loosely by Node module scope). */
  private latestVersionCache: { version: string; fetchedAt: number } | null = null;

  private async fetchLatestVersion(): Promise<string> {
    const FALLBACK = '1.4.6';
    const now = Date.now();
    if (this.latestVersionCache && now - this.latestVersionCache.fetchedAt < 3600_000) {
      return this.latestVersionCache.version;
    }
    return new Promise((resolve) => {
      const req = https.get(
        'https://api.github.com/repos/rustdesk/rustdesk/releases/latest',
        { headers: { 'User-Agent': 'reboot-remote', Accept: 'application/vnd.github.v3+json' } },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const version: string = json.tag_name ?? FALLBACK;
              this.latestVersionCache = { version, fetchedAt: now };
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
  @Get('install/:platform')
  @Public()
  async getInstallScript(
    @Param('platform') platform: string,
    @Query('token') enrollToken: string | undefined,
    @Res() res: Response,
  ) {
    const settings = await this.getSettings();
    const host = settings?.rustdeskRelayHost ?? null;
    const key = settings?.rustdeskPublicKey ?? null;
    const version = await this.fetchLatestVersion();

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
      script = this.buildWindowsScript(version, host, key, validatedToken);
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

  private buildWindowsScript(version: string, host: string | null, key: string | null, enrollToken?: string): string {
    const hostVal = host ?? '';
    const keyVal = key ?? '';
    const claimToken = enrollToken ?? '';
    return `# Reboot Remote — RustDesk Auto-Installer for Windows
# Server: ${host ?? 'NOT CONFIGURED'}
# Re-run this script at any time to update the server config.

$ErrorActionPreference = "Continue"

if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Host "ERROR: Run this script as Administrator." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

$VERSION    = "${version}"
$HOST_ADDR  = "${hostVal}"
$PUB_KEY    = "${keyVal}"
$CLAIM_TOKEN = "${claimToken}"
$INSTALLER  = "$env:TEMP\\rustdesk-setup.exe"
$RDEXE      = "C:\\Program Files\\RustDesk\\rustdesk.exe"

# Generate a permanent password for this device (replaces the rotating one-time password)
$chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
$PERM_PW = -join (1..12 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })

Write-Host ""
Write-Host "  Reboot Remote — Installing RustDesk remote support client" -ForegroundColor Cyan
Write-Host ""

# [1/4] Download
Write-Host "[1/4] Downloading RustDesk v$VERSION..." -ForegroundColor Yellow
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dlUrl = "https://github.com/rustdesk/rustdesk/releases/download/$VERSION/rustdesk-$VERSION-x86_64.exe"
try {
    Invoke-WebRequest -Uri $dlUrl -OutFile $INSTALLER -UseBasicParsing
} catch {
    Write-Host "ERROR: Download failed — $_" -ForegroundColor Red
    exit 1
}

# [2/4] Stop any running RustDesk before installing/reconfiguring
Write-Host "[2/4] Stopping existing RustDesk (if running)..." -ForegroundColor Yellow
# Use taskkill — faster and non-blocking unlike Stop-Service -Force
& taskkill /F /IM rustdesk.exe /T 2>$null | Out-Null
& sc.exe stop RustDesk 2>$null | Out-Null
Start-Sleep -Seconds 2

# Install silently — NSIS /S flag
Write-Host "     Installing..." -ForegroundColor Yellow
$install = Start-Process -FilePath $INSTALLER -ArgumentList "/S" -PassThru
$install.WaitForExit(180000)
Remove-Item $INSTALLER -ErrorAction SilentlyContinue

if (-not (Test-Path $RDEXE)) {
    Write-Host "ERROR: Installation failed — $RDEXE not found." -ForegroundColor Red
    exit 1
}

# Let the service start briefly so it initialises its config directories
Start-Service -Name "RustDesk" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5

# Now kill everything so we can safely overwrite the config
Write-Host "     Stopping RustDesk to apply custom server config..." -ForegroundColor Yellow
& taskkill /F /IM rustdesk.exe /T 2>$null | Out-Null
& sc.exe stop RustDesk 2>$null | Out-Null
Start-Sleep -Seconds 3

# [3/4] Write server config — overwrite every possible path
Write-Host "[3/4] Configuring server ($HOST_ADDR)..." -ForegroundColor Yellow

$tomlContent = @"
rendezvous_server = '${hostVal}:21116'
nat_type = 1
serial = 2

[options]
custom-rendezvous-server = '${hostVal}'
relay-server = '${hostVal}'
api-server = ''
key = '${keyVal}'
verification-method = 'use-permanent-password'
"@

# Build list of ALL config paths to write
$cfgDirs = [System.Collections.Generic.List[string]]::new()

# All real user profiles
Get-ChildItem "C:\\Users" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $cfgDirs.Add("$($_.FullName)\\AppData\\Roaming\\RustDesk\\config")
}

# Service / system accounts
@(
    "$env:APPDATA\\RustDesk\\config",
    "C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming\\RustDesk\\config",
    "C:\\Windows\\SysWOW64\\config\\systemprofile\\AppData\\Roaming\\RustDesk\\config",
    "C:\\Windows\\ServiceProfiles\\LocalSystem\\AppData\\Roaming\\RustDesk\\config",
    "C:\\Windows\\ServiceProfiles\\NetworkService\\AppData\\Roaming\\RustDesk\\config",
    "C:\\ProgramData\\RustDesk\\config"
) | ForEach-Object { if (-not $cfgDirs.Contains($_)) { $cfgDirs.Add($_) } }

foreach ($d in $cfgDirs) {
    try {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        $tomlContent | Set-Content "$d\\RustDesk2.toml" -Encoding UTF8
        Write-Host "  Wrote: $d" -ForegroundColor DarkGray
    } catch {
        Write-Host "  Skip (no access): $d" -ForegroundColor DarkGray
    }
}

# [4/4] Set permanent password (service still stopped) then start
Write-Host "[4/4] Setting permanent password and starting RustDesk service..." -ForegroundColor Yellow

# Set password BEFORE starting the service so it is already in the config on first read.
# With the service stopped this writes directly to the TOML file instead of going via IPC.
& "$RDEXE" --password "$PERM_PW" 2>$null | Out-Null
Start-Sleep -Seconds 2

Start-Service -Name "RustDesk" -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5

# Read the assigned RustDesk ID from any available config
$rdId = ""
$idPaths = @(
    "$env:APPDATA\\RustDesk\\config\\RustDesk.toml",
    "C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming\\RustDesk\\config\\RustDesk.toml",
    "C:\\Windows\\ServiceProfiles\\LocalSystem\\AppData\\Roaming\\RustDesk\\config\\RustDesk.toml",
    "C:\\Windows\\ServiceProfiles\\LocalSystem\\AppData\\Roaming\\RustDesk\\config\\RustDesk2.toml"
)
foreach ($f in $idPaths) {
    if (Test-Path $f) {
        $line = Get-Content $f -ErrorAction SilentlyContinue | Where-Object { $_ -match '^id\\s*=' } | Select-Object -First 1
        if ($line -match '"(.+)"') { $rdId = $Matches[1]; break }
        if ($line -match "=\\s*'(.+)'") { $rdId = $Matches[1]; break }
    }
}

if ($CLAIM_TOKEN -and $rdId) {
    Write-Host "  Registering device with management portal..." -ForegroundColor Yellow
    try {
        $claimBody = @{ token = $CLAIM_TOKEN; rustdeskId = $rdId; hostname = $env:COMPUTERNAME; platform = "Windows"; password = $PERM_PW } | ConvertTo-Json
        Invoke-RestMethod -Uri "https://$HOST_ADDR/api/v1/enrollment/claim" -Method Post -Body $claimBody -ContentType "application/json" -UseBasicParsing -ErrorAction Stop | Out-Null
        Write-Host "  Device registered to management portal." -ForegroundColor Green
    } catch {
        Write-Host "  Portal registration skipped (will retry on next heartbeat)." -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "=============================================" -ForegroundColor Green
Write-Host "  RustDesk installed and running as service!" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
if ($rdId) {
    Write-Host ""
    Write-Host "  Device ID:         $rdId" -ForegroundColor Cyan
    Write-Host "  Permanent password: $PERM_PW" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  IMPORTANT: Save this password in your remote management portal." -ForegroundColor Yellow
    Write-Host "  The one-time rotating password has been DISABLED on this device." -ForegroundColor Yellow
}
if ($HOST_ADDR) {
    Write-Host ""
    Write-Host "  Connected to server: $HOST_ADDR" -ForegroundColor Gray
}
Write-Host ""
Write-Host "  The RustDesk service starts automatically with Windows." -ForegroundColor Gray
Write-Host "  Run this script again at any time to update the server config." -ForegroundColor Gray
Write-Host ""
Read-Host "Press Enter to close"
`;
  }

  private buildLinuxScript(version: string, host: string | null, key: string | null, enrollToken?: string): string {
    const hostVal = host ?? '';
    const keyVal = key ?? '';
    const claimToken = enrollToken ?? '';
    return `#!/usr/bin/env bash
# Reboot Remote — RustDesk Auto-Installer for Linux (Debian/Ubuntu)
# Server: ${host ?? 'NOT CONFIGURED'}
# Re-run this script at any time to update the server config.
set -euo pipefail

VERSION="${version}"
HOST_ADDR="${hostVal}"
PUB_KEY="${keyVal}"
CLAIM_TOKEN="${claimToken}"

RED='\\033[0;31m'; GREEN='\\033[0;32m'; YELLOW='\\033[1;33m'; CYAN='\\033[0;36m'; NC='\\033[0m'

# Generate a permanent password for this device
PERM_PW=$(LC_ALL=C tr -dc 'A-Za-z2-9' < /dev/urandom | head -c 12)

[ "$EUID" -eq 0 ] || { echo -e "\${RED}ERROR: Run as root: sudo bash\${NC}"; exit 1; }

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
sleep 3

# Try to read RustDesk ID
RD_ID=""
for CFG_FILE in "/root/.config/rustdesk/RustDesk.toml" "/var/lib/rustdesk/RustDesk.toml" "/root/.config/rustdesk/RustDesk2.toml"; do
  if [ -f "\${CFG_FILE}" ]; then
    RD_ID=\$(grep '^id' "\${CFG_FILE}" 2>/dev/null | head -1 | sed "s/.*'\\(.*\\)'.*/\\1/" | sed 's/.*"\\(.*\\)".*/\\1/') || true
    [ -n "\${RD_ID}" ] && break
  fi
done

# Auto-register with management portal
if [ -n "\${CLAIM_TOKEN}" ] && [ -n "\${RD_ID}" ]; then
  echo "  Registering device with management portal..."
  curl -s -X POST "https://\${HOST_ADDR}/api/v1/enrollment/claim" \\
    -H "Content-Type: application/json" \\
    -d "{\\"token\\":\\"\${CLAIM_TOKEN}\\",\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\$(hostname -s 2>/dev/null || echo unknown)\\",\\"platform\\":\\"linux\\",\\"password\\":\\"\${PERM_PW}\\"}" >/dev/null 2>&1 || true
  echo "  Device registered to management portal."
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
    const hostVal = host ?? '';
    const keyVal = key ?? '';
    const claimToken = enrollToken ?? '';
    return `#!/usr/bin/env bash
# Reboot Remote — RustDesk Auto-Installer for macOS
# Server: ${host ?? 'NOT CONFIGURED'}
# Re-run this script at any time to update the server config.
set -euo pipefail

VERSION="${version}"
HOST_ADDR="${hostVal}"
PUB_KEY="${keyVal}"
CLAIM_TOKEN="${claimToken}"

# Generate a permanent password for this device
PERM_PW=$(LC_ALL=C tr -dc 'A-Za-z2-9' < /dev/urandom | head -c 12)

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
sleep 5

# Read ID from config
RD_ID=""
for CFG in "\${HOME}/Library/Preferences/com.carriez.RustDesk/RustDesk.toml" \\
           "\${HOME}/Library/Application Support/com.carriez.RustDesk/RustDesk.toml"; do
  if [ -f "\${CFG}" ]; then
    RD_ID=\$(grep '^id' "\${CFG}" 2>/dev/null | head -1 | sed "s/.*'\\(.*\\)'.*/\\1/" | sed 's/.*"\\(.*\\)".*/\\1/') || true
    [ -n "\${RD_ID}" ] && break
  fi
done

# Auto-register with management portal
if [ -n "\${CLAIM_TOKEN}" ] && [ -n "\${RD_ID}" ]; then
  echo "  Registering device with management portal..."
  curl -s -X POST "https://\${HOST_ADDR}/api/v1/enrollment/claim" \\
    -H "Content-Type: application/json" \\
    -d "{\\"token\\":\\"\${CLAIM_TOKEN}\\",\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\$(hostname -s 2>/dev/null || echo unknown)\\",\\"platform\\":\\"macos\\",\\"password\\":\\"\${PERM_PW}\\"}" >/dev/null 2>&1 || true
  echo "  Device registered to management portal."
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
