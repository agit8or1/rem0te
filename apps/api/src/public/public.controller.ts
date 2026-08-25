import { BadRequestException, Controller, Get, Param, Query, Res, Req } from '@nestjs/common';
import { Response, Request } from 'express';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import * as https from 'https';

const INSTALLER_MAGIC = Buffer.from('REM0TE_INST_URL:');
const INSTALLER_SLOT_SIZE = 256;

// Strict allowlists for values interpolated into generated shell / PowerShell scripts.
// A hostile or corrupted tenant setting must never be able to break out of a quoted
// string and inject arbitrary shell commands into the customer-run installer.
const HOSTNAME_RE = /^[a-zA-Z0-9._-]{1,253}$/;
const BASE64_RE = /^[A-Za-z0-9+/]{16,512}={0,2}$/;
const HEX_TOKEN_RE = /^[A-Fa-f0-9]{16,128}$/;
const VERSION_RE = /^[a-zA-Z0-9._+-]{1,32}$/;

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
  if (!VERSION_RE.test(version)) return '1.4.6';
  return version;
}

@Controller('public')
export class PublicController {
  private readonly projectRoot = process.env.PROJECT_ROOT ?? path.join(process.cwd(), '..', '..');

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

  @Get('install/:platform')
  @Public()
  async getInstallScript(
    @Param('platform') platform: string,
    @Query('token') enrollToken: string | undefined,
    @Res() res: Response,
    @Req() req: Request,
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
    } else if (platform === 'windows.exe') {
      // Prefer the configured public URL over spoofable request headers. Falling back
      // to headers only if PUBLIC_API_URL is unset. The URL is embedded inside the
      // installer and controls where the customer's machine fetches the PowerShell
      // script from, so header trust is a supply-chain risk.
      const configuredBase = process.env.PUBLIC_API_URL?.replace(/\/+$/, '');
      let apiUrl: string;
      if (configuredBase && /^https?:\/\/[a-zA-Z0-9.:_-]+/.test(configuredBase)) {
        apiUrl = configuredBase;
      } else {
        const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
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

  private buildWindowsScript(version: string, host: string | null, key: string | null, enrollToken?: string): string {
    const hostVal = safeHost(host);
    const keyVal = safeKey(key);
    const claimToken = safeToken(enrollToken);
    version = safeVersion(version);
    // Base64-encoded server config for `rustdesk.exe --config <base64>`. This is the
    // documented mechanism to reconfigure an already-installed RustDesk without
    // touching the TOML files. Format: host=...,key=...,relay=...,api=
    const configPlain = `host=${hostVal},key=${keyVal},api=,relay=${hostVal}`;
    const configB64 = Buffer.from(configPlain, 'utf8').toString('base64');
    return `# Rem0te Managed Agent — Windows installer
# Server: ${host ?? 'NOT CONFIGURED'}
# Safe to re-run; existing installs will be reconfigured, not duplicated.

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'

# ── Constants (server-side embedded) ────────────────────────────────────────
$REM0TE_HOST   = '${hostVal}'
$REM0TE_KEY    = '${keyVal}'
$REM0TE_CONFIG = '${configB64}'
$CLAIM_TOKEN   = '${claimToken}'
$VERSION       = '${version}'

$RDEXE = 'C:\\Program Files\\RustDesk\\rustdesk.exe'
$LOGDIR = 'C:\\ProgramData\\Rem0te\\Logs'
$LOG = "$LOGDIR\\install.log"
$STATEDIR = 'C:\\ProgramData\\Rem0te'
$SETUP_DIR = "$env:TEMP\\rem0te-install"

# ── Helpers ─────────────────────────────────────────────────────────────────
function Log([string]$msg, [string]$level = 'INFO') {
    try { if (-not (Test-Path $LOGDIR)) { New-Item -ItemType Directory -Force -Path $LOGDIR | Out-Null } } catch {}
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    $line = "[$ts] [$level] $msg"
    try { Add-Content -Path $LOG -Value $line -ErrorAction SilentlyContinue } catch {}
    switch ($level) {
        'ERROR' { Write-Host $msg -ForegroundColor Red }
        'WARN'  { Write-Host $msg -ForegroundColor Yellow }
        'OK'    { Write-Host $msg -ForegroundColor Green }
        default { Write-Host $msg }
    }
}
function Step([int]$n, [int]$total, [string]$msg) { Log ("[$n/$total] " + $msg) }
function Fail([string]$msg, [int]$code = 1) {
    Log $msg 'ERROR'
    Log "Install log: $LOG" 'ERROR'
    exit $code
}
function IsInteractive { return [Environment]::UserInteractive -and $Host.Name -notmatch 'ServerRemoteHost' }
function TestAdmin {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$me).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Stop-Rustdesk {
    & sc.exe stop RustDesk 2>$null | Out-Null
    & taskkill /F /IM rustdesk.exe /T 2>$null | Out-Null
    Start-Sleep -Seconds 2
}

Write-Host ''
Write-Host '  Rem0te Managed Agent' -ForegroundColor Cyan
Write-Host ''

if (-not (TestAdmin)) { Fail 'ERROR: Run this script as Administrator.' 2 }
Log "Rem0te installer starting. server=$REM0TE_HOST version=$VERSION claim=$($CLAIM_TOKEN.Length -gt 0)"

# ── [1/6] Download ─────────────────────────────────────────────────────────
Step 1 6 'Preparing installer...'
try { New-Item -ItemType Directory -Force -Path $SETUP_DIR | Out-Null } catch {}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# The RustDesk MSP-config-in-filename technique: name the setup exe so its own
# filename encodes the server config. On install RustDesk parses its name and
# atomically writes the server config — no TOML shotgun required.
# https://rustdesk.com/docs/en/self-host/rustdesk-server-oss/install/#windows
$installerName = "rustdesk-host=$REM0TE_HOST,key=$REM0TE_KEY.exe"
# Strip characters that are legal in RustDesk's config but illegal in Windows filenames.
$installerName = ($installerName -replace '[<>:"/\\\\|?*]', '_')
$INSTALLER = Join-Path $SETUP_DIR $installerName
$dlUrl = "https://github.com/rustdesk/rustdesk/releases/download/$VERSION/rustdesk-$VERSION-x86_64.exe"
Log "Downloading $dlUrl -> $INSTALLER"
try {
    Invoke-WebRequest -Uri $dlUrl -OutFile $INSTALLER -UseBasicParsing
} catch { Fail "ERROR: Download failed: $($_.Exception.Message)" 10 }

# ── [2/6] Stop existing RustDesk and install ───────────────────────────────
Step 2 6 'Installing remote-support service...'
Stop-Rustdesk
$install = Start-Process -FilePath $INSTALLER -ArgumentList '/S' -PassThru -WindowStyle Hidden
$install.WaitForExit(180000)
# Wait for rustdesk.exe to appear (NSIS installer child processes may finish after the stub)
$waited = 0
while (-not (Test-Path $RDEXE) -and $waited -lt 90) { Start-Sleep -Seconds 2; $waited += 2 }
if (-not (Test-Path $RDEXE)) { Fail "ERROR: Installation failed — $RDEXE not found after $waited s." 11 }
try { Remove-Item $INSTALLER -Force -ErrorAction SilentlyContinue } catch {}

# ── [3/6] Apply Rem0te server configuration ────────────────────────────────
Step 3 6 "Configuring server ($REM0TE_HOST)..."
# Stop the service so the CLI writes directly to the config, not via a running-service IPC race.
Stop-Rustdesk

$svcDir = 'C:\\Windows\\ServiceProfiles\\LocalSystem\\AppData\\Roaming\\RustDesk\\config'
$sysDir = 'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming\\RustDesk\\config'

# Wipe any pre-existing RustDesk2.toml that might be pointing at public rustdesk.com
# servers from a prior manual install. We leave RustDesk.toml alone so the assigned
# device id (if any) survives; --config below will populate the new server settings.
$wipeDirs = @($svcDir, $sysDir, "$env:APPDATA\\RustDesk\\config", 'C:\\ProgramData\\RustDesk\\config')
foreach ($d in $wipeDirs) {
    Remove-Item "$d\\RustDesk2.toml" -Force -ErrorAction SilentlyContinue
}

# --config takes a base64-encoded 'host=X,key=Y,api=,relay=Z' string and rewrites
# RustDesk2.toml + rendezvous_server atomically. Works on all RustDesk 1.4.x.
& $RDEXE --config $REM0TE_CONFIG *>$null

# RustDesk keeps SEPARATE configs for (a) the LocalSystem service and
# (b) every interactive Windows user's GUI. If we only fix the service the
# desktop GUI keeps displaying "For faster connection, please set up your
# own server" and can even initiate connections against public rustdesk.com
# rendezvous. So: write the authoritative RustDesk2.toml into
#   - service profile (LocalSystem + systemprofile — for the running service)
#   - every real user profile that has AppData
#   - C:\Users\Default so any future new user gets the Rem0te config
$toml = @"
rendezvous_server = '$($REM0TE_HOST):21116'
nat_type = 1
serial = 3

[options]
custom-rendezvous-server = '$REM0TE_HOST'
relay-server = '$REM0TE_HOST'
api-server = ''
key = '$REM0TE_KEY'
"@

$configTargets = New-Object System.Collections.Generic.List[string]
$configTargets.Add($svcDir) | Out-Null
$configTargets.Add($sysDir) | Out-Null

# Every user profile the OS knows about — from ProfileList registry, not from
# a naive C:\Users scan (that missed domain profiles / picked up junk like Public).
try {
    $profileList = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList' -ErrorAction Stop
    foreach ($p in $profileList) {
        $sid = Split-Path $p.Name -Leaf
        # Skip well-known system SIDs: S-1-5-18 LocalSystem, S-1-5-19 LocalService, S-1-5-20 NetworkService
        if ($sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { continue }
        $pip = (Get-ItemProperty -Path $p.PSPath -Name 'ProfileImagePath' -ErrorAction SilentlyContinue).ProfileImagePath
        if (-not $pip) { continue }
        $ad = Join-Path $pip 'AppData\\Roaming\\RustDesk\\config'
        if (Test-Path (Split-Path $ad)) { $configTargets.Add($ad) | Out-Null }
    }
} catch { Log "  Could not enumerate user profiles: $($_.Exception.Message)" 'WARN' }

# C:\Users\Default so future first-logins inherit the Rem0te config
$defaultDir = 'C:\\Users\\Default\\AppData\\Roaming\\RustDesk\\config'
if (Test-Path 'C:\\Users\\Default') { $configTargets.Add($defaultDir) | Out-Null }

# De-dupe
$configTargets = [System.Linq.Enumerable]::Distinct([string[]]$configTargets)

foreach ($d in $configTargets) {
    try {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        $toml | Set-Content "$d\\RustDesk2.toml" -Encoding UTF8 -Force
        Log "  Wrote config: $d\\RustDesk2.toml"
    } catch {
        Log "  Skip (no access): $d — $($_.Exception.Message)" 'WARN'
    }
}

# Kill any running RustDesk GUI/tray so it re-reads the new config on next start.
Get-Process -Name rustdesk -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -ne 0 } | ForEach-Object {
    try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch {}
}

# Set a strong internal password so the endpoint accepts authenticated Rem0te
# sessions. Not displayed to the operator; stored server-side by heartbeat.
$rnd = New-Object byte[] 24
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($rnd)
$PERM_PW = [Convert]::ToBase64String($rnd).Replace('+','A').Replace('/','B').Replace('=','').Substring(0,20)
& $RDEXE --password $PERM_PW *>$null

# ── [4/6] Start service and verify config ──────────────────────────────────
Step 4 6 'Starting service...'
& sc.exe config RustDesk start= auto 2>$null | Out-Null
& sc.exe start RustDesk 2>$null | Out-Null
Start-Sleep -Seconds 4

# Verify effective config across EVERY RustDesk2.toml the OS knows about —
# not just $env:APPDATA. Detects service-vs-user divergence (service configured
# for Rem0te but the interactive user's GUI still pointed at rustdesk.com).
function Get-AllConfigs {
    $paths = @("$svcDir\\RustDesk2.toml", "$sysDir\\RustDesk2.toml")
    try {
        $profileList = Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList' -ErrorAction Stop
        foreach ($p in $profileList) {
            $sid = Split-Path $p.Name -Leaf
            if ($sid -in @('S-1-5-18','S-1-5-19','S-1-5-20')) { continue }
            $pip = (Get-ItemProperty -Path $p.PSPath -Name 'ProfileImagePath' -ErrorAction SilentlyContinue).ProfileImagePath
            if ($pip) { $paths += (Join-Path $pip 'AppData\\Roaming\\RustDesk\\config\\RustDesk2.toml') }
        }
    } catch {}
    return ($paths | Where-Object { Test-Path $_ })
}
function Get-ConfigServer([string]$path) {
    $c = Get-Content $path -Raw -ErrorAction SilentlyContinue
    if (-not $c) { return $null }
    $r = $null; $cs = $null
    if ($c -match 'custom-rendezvous-server\\s*=\\s*[''"]([^''"]+)[''"]') { $cs = $Matches[1] }
    if ($c -match 'rendezvous_server\\s*=\\s*[''"]([^''"]+)[''"]') { $r = $Matches[1] }
    return [PSCustomObject]@{ path = $path; rendezvous = $r; customRendezvous = $cs }
}
function Verify-AllConfigs {
    $bad = @()
    foreach ($p in (Get-AllConfigs)) {
        $s = Get-ConfigServer $p
        if (-not $s) { continue }
        $host_ok = ($s.customRendezvous -eq $REM0TE_HOST)
        # rendezvous_server may be blank on first run or contain host:port
        $rz_ok  = (-not $s.rendezvous) -or ($s.rendezvous -like "$REM0TE_HOST*")
        $public = ($s.rendezvous -match 'rustdesk\\.com') -or ($s.customRendezvous -match 'rustdesk\\.com')
        if (-not $host_ok -or -not $rz_ok -or $public) {
            $bad += $s
            Log ("  BAD: " + $s.path + " -> custom=" + $s.customRendezvous + " rz=" + $s.rendezvous) 'WARN'
        } else {
            Log ("  OK:  " + $s.path + " -> custom=" + $s.customRendezvous + " rz=" + $s.rendezvous)
        }
    }
    return $bad
}
$bad = Verify-AllConfigs
if ($bad.Count -gt 0) {
    # Repair: rewrite bad files, then re-verify.
    Log "  Repairing $($bad.Count) config file(s)..." 'WARN'
    foreach ($b in $bad) {
        try {
            $dir = Split-Path $b.path -Parent
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            $toml | Set-Content $b.path -Encoding UTF8 -Force
        } catch {}
    }
    Stop-Rustdesk
    & $RDEXE --config $REM0TE_CONFIG *>$null
    Start-Sleep -Seconds 1
    & sc.exe start RustDesk 2>$null | Out-Null
    Start-Sleep -Seconds 3
    $bad = Verify-AllConfigs
}
if ($bad.Count -gt 0) {
    $stillPublic = $bad | Where-Object { ($_.rendezvous -match 'rustdesk\\.com') -or ($_.customRendezvous -match 'rustdesk\\.com') }
    if ($stillPublic) {
        Fail "ERROR: RustDesk still uses a public server after repair. Refusing to report success." 20
    }
}
Log "  Server config verified across $((Get-AllConfigs).Count) profile(s)."

# ── [5/6] Acquire RustDesk device ID ───────────────────────────────────────
Step 5 6 'Waiting for device identity...'
function Get-RustdeskId {
    # Primary: ask the running RustDesk directly.
    try {
        $out = & $RDEXE --get-id 2>$null | Out-String
        if ($out -match '([0-9]{6,15})') { return $Matches[1] }
    } catch {}
    # Fallback: read the id from any RustDesk.toml the service has written.
    $paths = @(
        "$svcDir\\RustDesk.toml",
        "$sysDir\\RustDesk.toml",
        "$env:APPDATA\\RustDesk\\config\\RustDesk.toml"
    )
    foreach ($p in $paths) {
        if (Test-Path $p) {
            $c = Get-Content $p -Raw -ErrorAction SilentlyContinue
            if ($c -match 'id\\s*=\\s*[''"]([0-9]{6,15})[''"]') { return $Matches[1] }
        }
    }
    return ''
}
$rdId = ''
$deadline = (Get-Date).AddSeconds(120)
while (-not $rdId -and (Get-Date) -lt $deadline) {
    $rdId = Get-RustdeskId
    if (-not $rdId) { Start-Sleep -Seconds 3 }
}

# ── [6/6] Register with Rem0te ─────────────────────────────────────────────
Step 6 6 'Registering with Rem0te...'
function Register([string]$id) {
    $body = @{ rustdeskId = $id; hostname = $env:COMPUTERNAME; platform = 'Windows'; osVersion = [Environment]::OSVersion.VersionString; password = $PERM_PW }
    if ($CLAIM_TOKEN) {
        $body['token'] = $CLAIM_TOKEN
        $json = $body | ConvertTo-Json -Compress
        try {
            Invoke-RestMethod -Uri "https://$REM0TE_HOST/api/v1/enrollment/claim" -Method Post -Body $json -ContentType 'application/json' -UseBasicParsing -ErrorAction Stop -TimeoutSec 15 | Out-Null
            return 'CLAIMED'
        } catch {
            Log "  Claim failed: $($_.Exception.Message) — falling back to heartbeat" 'WARN'
        }
        $body.Remove('token') | Out-Null
    }
    $json = $body | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Uri "https://$REM0TE_HOST/api/v1/enrollment/heartbeat" -Method Post -Body $json -ContentType 'application/json' -UseBasicParsing -ErrorAction Stop -TimeoutSec 15 | Out-Null
        return 'HEARTBEAT'
    } catch {
        Log "  Heartbeat failed: $($_.Exception.Message)" 'WARN'
        return ''
    }
}

$registered = ''
if ($rdId) { $registered = Register $rdId }

if (-not $rdId -or -not $registered) {
    # Schedule a retry task. Runs every 5 minutes for up to 24 hours, then self-deletes.
    Log "  Immediate registration incomplete; scheduling retry task." 'WARN'
    try { New-Item -ItemType Directory -Force -Path $STATEDIR | Out-Null } catch {}
    $secretFile = "$STATEDIR\\enroll.dat"
    $payload = [PSCustomObject]@{
        host = $REM0TE_HOST; token = $CLAIM_TOKEN; password = $PERM_PW
        expiresAt = (Get-Date).AddDays(1).ToString('o')
    } | ConvertTo-Json -Compress
    try { Set-Content -Path $secretFile -Value $payload -Encoding UTF8; icacls $secretFile /inheritance:r /grant:r 'SYSTEM:(F)' 'Administrators:(F)' *>$null } catch {}

    $retryScript = "$STATEDIR\\retry-enroll.ps1"
    $retryBody = @'
\$ErrorActionPreference = 'Continue'; \$ProgressPreference = 'SilentlyContinue'
\$state = Get-Content 'C:\\ProgramData\\Rem0te\\enroll.dat' -Raw | ConvertFrom-Json
if ((Get-Date) -gt [DateTime]\$state.expiresAt) { schtasks /Delete /TN 'Rem0teEnrollment' /F | Out-Null; Remove-Item 'C:\\ProgramData\\Rem0te\\enroll.dat' -Force -ErrorAction SilentlyContinue; exit 0 }
\$RDEXE = 'C:\\Program Files\\RustDesk\\rustdesk.exe'
\$id = ''
try { \$out = & \$RDEXE --get-id 2>\$null | Out-String; if (\$out -match '([0-9]{6,15})') { \$id = \$Matches[1] } } catch {}
if (-not \$id) { exit 0 }
\$body = @{ rustdeskId = \$id; hostname = \$env:COMPUTERNAME; platform = 'Windows'; password = \$state.password }
if (\$state.token) { \$body['token'] = \$state.token }
\$json = \$body | ConvertTo-Json -Compress
\$endpoint = if (\$state.token) { 'enrollment/claim' } else { 'enrollment/heartbeat' }
try {
    Invoke-RestMethod -Uri ('https://' + \$state.host + '/api/v1/' + \$endpoint) -Method Post -Body \$json -ContentType 'application/json' -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop | Out-Null
    Remove-Item 'C:\\ProgramData\\Rem0te\\enroll.dat' -Force -ErrorAction SilentlyContinue
    schtasks /Delete /TN 'Rem0teEnrollment' /F | Out-Null
} catch {}
'@
    Set-Content -Path $retryScript -Value $retryBody -Encoding UTF8
    schtasks /Create /F /TN 'Rem0teEnrollment' /SC MINUTE /MO 5 /RU SYSTEM /RL HIGHEST /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$retryScript\`"" *>$null
    Log "  Retry task installed: 'Rem0teEnrollment' (every 5 minutes for 24 hours)."
} else {
    # Success path: no secret spills to disk.
    Log "  Registered ($registered) as $rdId" 'OK'
}

# ── Summary ────────────────────────────────────────────────────────────────
Write-Host ''
Write-Host '  ─────────────────────────────────────────────' -ForegroundColor Green
if ($rdId -and $registered) {
    Write-Host '  Rem0te installed successfully' -ForegroundColor Green
} elseif ($rdId) {
    Write-Host '  Rem0te installed. Registration will retry in background.' -ForegroundColor Yellow
} else {
    Write-Host '  Rem0te installed. Device ID not yet assigned — retry task will finish enrollment.' -ForegroundColor Yellow
}
Write-Host '  ─────────────────────────────────────────────' -ForegroundColor Green
Write-Host ''
Write-Host "  Device:   $env:COMPUTERNAME"
Write-Host "  Server:   $REM0TE_HOST"
if ($rdId) { Write-Host "  Device ID: $rdId" }
Write-Host "  Log:      $LOG"
Write-Host ''

if (IsInteractive) { try { Read-Host 'Press Enter to close' | Out-Null } catch {} }
exit 0
`;
  }

  private async serveWindowsExe(psUrl: string, res: Response): Promise<void> {
    const exePath = path.join(this.projectRoot, 'dist', 'windows-installer.exe');
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
      -d "{\\"token\\":\\"\${CLAIM_TOKEN}\\",\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"linux\\",\\"password\\":\\"\${PERM_PW}\\"}" >/dev/null; then
      echo "  Claim failed — falling back to unassigned registration."
      curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/heartbeat" \\
        -H "Content-Type: application/json" \\
        -d "{\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"linux\\",\\"password\\":\\"\${PERM_PW}\\"}" >/dev/null || true
    else
      echo "  Device registered to tenant."
    fi
  else
    echo "  Registering device with Rem0te (no claim token — will appear as Unassigned)..."
    curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/heartbeat" \\
      -H "Content-Type: application/json" \\
      -d "{\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"linux\\",\\"password\\":\\"\${PERM_PW}\\"}" >/dev/null || true
    echo "  Device registered. Assign it under Admin -> Unassigned Devices."
  fi
else
  echo "  Could not detect RustDesk Device ID after 45 s — skipping registration."
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
      -d "{\\"token\\":\\"\${CLAIM_TOKEN}\\",\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"macos\\",\\"password\\":\\"\${PERM_PW}\\"}" >/dev/null; then
      echo "  Claim failed — falling back to unassigned registration."
      curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/heartbeat" \\
        -H "Content-Type: application/json" \\
        -d "{\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"macos\\",\\"password\\":\\"\${PERM_PW}\\"}" >/dev/null || true
    else
      echo "  Device registered to tenant."
    fi
  else
    echo "  Registering device with Rem0te (no claim token — will appear as Unassigned)..."
    curl -sf -X POST "https://\${HOST_ADDR}/api/v1/enrollment/heartbeat" \\
      -H "Content-Type: application/json" \\
      -d "{\\"rustdeskId\\":\\"\${RD_ID}\\",\\"hostname\\":\\"\${HOSTNAME_SHORT}\\",\\"platform\\":\\"macos\\",\\"password\\":\\"\${PERM_PW}\\"}" >/dev/null || true
    echo "  Device registered. Assign it under Admin -> Unassigned Devices."
  fi
else
  echo "  Could not detect RustDesk Device ID after 45 s — skipping registration."
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
