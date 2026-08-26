import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The two things every RustDesk-facing surface needs: where this server is,
 * and a copy of the client binary.
 *
 * Both were being rebuilt per feature. Quick Connect, the installer templates
 * and the launcher each read the relay host and key out of TenantSettings and
 * re-derived the config string; Quick Connect separately owned the only cache
 * of the client executable, which meant any new download surface either
 * duplicated a 40-line GitHub fetch or reached into another module's cache
 * directory. Same shape of drift that left three different "latest version"
 * implementations behind — see common/rustdesk-release.ts.
 */

const HOSTNAME_RE = /^[a-zA-Z0-9._-]{1,253}$/;
const BASE64_KEY_RE = /^[A-Za-z0-9+/]{16,512}={0,2}$/;

export interface RustdeskServerConfig {
  host: string;
  key: string;
  /**
   * Base64 `host=…,key=…,api=,relay=…`, the argument to `rustdesk --config`.
   * This is the documented way to point an already-installed client at a
   * server without editing its TOML files, and it is what the installer, the
   * launcher and the technician setup script all apply.
   */
  configB64: string;
}

@Injectable()
export class RustdeskService {
  private readonly logger = new Logger(RustdeskService.name);
  private readonly cacheDir = path.join(
    process.env.PROJECT_ROOT ?? process.cwd(),
    'cache',
    'rustdesk-clients',
  );

  constructor(private readonly prisma: PrismaService) {}

  /**
   * This server's RustDesk coordinates, or null when the platform has not been
   * configured — or when what is stored could not be trusted into a config
   * string. A malformed host would otherwise be handed to a client that parses
   * it into a half-applied server address, which fails later and somewhere
   * less obvious than here.
   */
  async serverConfig(): Promise<RustdeskServerConfig | null> {
    const settings = await this.prisma.tenantSettings.findFirst({
      select: { rustdeskRelayHost: true, rustdeskPublicKey: true },
      orderBy: { createdAt: 'asc' },
    });
    const host = settings?.rustdeskRelayHost ?? '';
    const key = settings?.rustdeskPublicKey ?? '';
    if (!HOSTNAME_RE.test(host)) return null;
    if (key && !BASE64_KEY_RE.test(key)) return null;

    const plain = `host=${host},key=${key},api=,relay=${host}`;
    return { host, key, configB64: Buffer.from(plain, 'utf8').toString('base64') };
  }
  /**
   * PowerShell that leaves `$rd` holding a path to rustdesk.exe, installing
   * one if the machine has none.
   *
   * Shared by the setup script and the per-connection script, which need the
   * same thing for different reasons.
   *
   * Emitted as one string rather than an array of statements joined with
   * "; ": joining that way puts a semicolon immediately after every `{`, and
   * nothing in this repo's toolchain can syntax-check PowerShell — there is
   * none on the build host. The one file that has to work should not depend on
   * a parser accepting something unusual.
   *
   * Backslashes are doubled deliberately. A template literal turns `\R` into a
   * bare `R`, which would search for `RustDeskrustdesk.exe`. Same class of bug
   * as `\U` in `C:\Users` — see the header of public.controller.ts.
   */
  private findOrInstallRustdesk(clientVersion: string, clientDownloadUrl: string): string {
    const githubUrl =
      `https://github.com/rustdesk/rustdesk/releases/download/${clientVersion}/rustdesk-${clientVersion}-x86_64.exe`;

    // Our own server first so a site with restricted egress still works, then
    // GitHub. We apply the config ourselves afterwards, so it does not matter
    // which of the two builds ends up installed.
    const sources = `@('${clientDownloadUrl}', '${githubUrl}')`;

    const install = [
      `Write-Host 'RustDesk is not installed. Downloading it...'`,
      `$tmp = Join-Path $env:TEMP 'rem0te-rustdesk-setup.exe'`,
      `$ok = $false`,
      `foreach ($u in ${sources}) { try { Invoke-WebRequest -Uri $u -OutFile $tmp -UseBasicParsing -TimeoutSec 300; $ok = $true; break } catch { } }`,
      `if (-not $ok) { Write-Host 'Could not download RustDesk. Check this computer can reach the internet.'; Read-Host 'Press Enter to close'; exit 1 }`,
      `Write-Host 'Installing RustDesk...'`,
      `Start-Process -FilePath $tmp -ArgumentList '--silent-install' -Wait`,
      `Start-Sleep -Seconds 3`,
      `$rd = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1`,
      `if (-not $rd) { Write-Host 'RustDesk did not finish installing. Run the downloaded installer by hand, then try again.'; Read-Host 'Press Enter to close'; exit 1 }`,
    ].join('; ');

    return [
      `$paths = @($env:ProgramFiles + '\\RustDesk\\rustdesk.exe', ${'${env:ProgramFiles(x86)}'} + '\\RustDesk\\rustdesk.exe')`,
      `$rd = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1`,
      `if (-not $rd) { $rd = (Get-Command rustdesk.exe -ErrorAction SilentlyContinue).Source }`,
      `if (-not $rd) { ${install} }`,
    ].join('; ');
  }

  /**
   * Wrap a PowerShell one-liner in a .cmd.
   *
   * A .cmd and not a .ps1 because PowerShell scripts do not run on
   * double-click under the default execution policy, and someone whose remote
   * support just broke should not also have to learn about
   * `Set-ExecutionPolicy`.
   *
   * The PowerShell body must contain no double quotes and no percent signs —
   * cmd.exe eats both before PowerShell ever sees them. Everything
   * interpolated into it is either a constrained charset (hostname, base64,
   * numeric peer id) or base64-encoded first.
   */
  private wrapCmd(title: string, comments: string[], ps: string, selfDelete: boolean): string {
    const lines = [
      '@echo off',
      `title ${title}`,
      'rem',
      ...comments.map((c) => (c ? `rem  ${c}` : 'rem')),
      'rem',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`,
      '',
    ];
    if (selfDelete) {
      lines.push(
        'rem  Self-delete. (goto) closes the batch context first so the file is',
        'rem  no longer held open by cmd.exe.',
        '(goto) 2>nul & del "%~f0"',
        '',
      );
    }
    // CRLF: a .cmd with bare LF endings loses the last token of every line.
    return lines.join('\r\n');
  }

  /**
   * Point this computer's RustDesk at this server, installing one if needed.
   *
   * The install step is not a nicety. The first version of this printed
   * "RustDesk is not installed, download the preconfigured client instead"
   * and stopped — a dead end handed to someone who came here precisely
   * because their remote support was broken. If the fix is "fetch a client and
   * configure it", the script can do both.
   */
  buildSetupCmd(config: RustdeskServerConfig, clientVersion: string, clientDownloadUrl: string): string {
    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `$cfg = '${config.configB64}'`,
      this.findOrInstallRustdesk(clientVersion, clientDownloadUrl),
      `Write-Host ('Pointing ' + $rd + ' at ${config.host} ...')`,
      `& $rd --config $cfg`,
      `Write-Host ''`,
      `Write-Host 'Done. This computer now uses ${config.host}.'`,
      `Write-Host 'Close RustDesk if it is open, then use Connect in Rem0te.'`,
      `Read-Host 'Press Enter to close'`,
    ].join('; ');

    return this.wrapCmd('Rem0te - set up RustDesk', [
      `Points this computer's RustDesk at ${config.host}, installing one`,
      'first if it is missing.',
      '',
      'Run once. The Connect button in Rem0te opens rustdesk://, which',
      'Windows hands to the installed RustDesk using whatever server that',
      'client is set to. If it has never been told about this server it',
      'asks rustdesk.com instead and reports every endpoint as offline.',
    ], ps, false);
  }

  /**
   * A single file that takes a technician from nothing to a connected session.
   *
   * The Connect button opens `rustdesk://connection/new/<id>`, which Windows
   * routes to the locally installed RustDesk using whatever server *that*
   * client is configured for. The URI scheme has no field for a server
   * address, so on a machine whose RustDesk has never been told about this
   * server it asks rustdesk.com, is told the ID is unknown, and reports "the
   * target device is offline or does not exist" about an endpoint that is
   * online and reachable. There is no fixing that from inside the link.
   *
   * So Connect hands over this instead: find RustDesk, install it if missing,
   * point it at this server, open the session. It assumes nothing about the
   * machine it runs on, which is the whole point.
   *
   * The password travels base64-encoded so no character in it can terminate a
   * string or be read as an operator, and the file deletes itself on the way
   * out — it carries a live credential and has no reason to persist in a
   * Downloads folder.
   */
  buildConnectCmd(opts: {
    config: RustdeskServerConfig;
    peerId: string;
    password: string | null;
    endpointName: string;
    clientDownloadUrl: string;
    clientVersion: string;
  }): string {
    const { config, peerId, password, endpointName, clientDownloadUrl, clientVersion } = opts;
    const pwB64 = Buffer.from(password ?? '', 'utf8').toString('base64');

    const ps = [
      `$ErrorActionPreference = 'Stop'`,
      `$cfg = '${config.configB64}'`,
      `$peer = '${peerId}'`,
      `$pw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pwB64}'))`,
      this.findOrInstallRustdesk(clientVersion, clientDownloadUrl),
      `Write-Host 'Pointing RustDesk at ${config.host} ...'`,
      `& $rd --config $cfg`,
      // The config lands via IPC to the running client; give it a moment
      // before the connection request or it uses the previous server.
      `Start-Sleep -Seconds 2`,
      `$uri = 'rustdesk://connection/new/' + $peer`,
      `if ($pw) { $uri = $uri + '?password=' + [Uri]::EscapeDataString($pw) }`,
      `Write-Host ('Connecting to ${endpointName} (' + $peer + ') ...')`,
      `Start-Process $uri`,
    ].join('; ');

    return this.wrapCmd(`Rem0te - connect to ${endpointName}`, [
      `Rem0te one-click connect: ${endpointName} (${peerId})`,
      '',
      'Installs RustDesk if this computer does not have it, points it at',
      `${config.host}, then opens the connection.`,
      '',
      'This file contains a live credential and deletes itself when it',
      'finishes. Do not keep or share it.',
    ], ps, true);
  }

  /**
   * Path to a cached Windows client, downloading it once if needed.
   *
   * Cached rather than proxied so a support call does not depend on GitHub
   * being reachable at the moment someone needs help. Downloads to `.part`
   * and renames, so a connection dropped mid-transfer cannot leave a truncated
   * executable that looks complete to the size check.
   */
  async cachedWindowsClient(version: string): Promise<string> {
    const target = path.join(this.cacheDir, `rustdesk-${version}-x86_64.exe`);
    if (fs.existsSync(target) && fs.statSync(target).size > 1_000_000) return target;

    fs.mkdirSync(this.cacheDir, { recursive: true });
    const url = `https://github.com/rustdesk/rustdesk/releases/download/${version}/rustdesk-${version}-x86_64.exe`;
    const tmp = `${target}.part`;

    this.logger.log(`Caching RustDesk client ${version} from ${url}`);
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
      this.logger.error(`RustDesk client download failed: ${err.message}`);
      throw new ServiceUnavailableException(
        'The RustDesk client could not be prepared. Try again in a moment.',
      );
    });

    fs.renameSync(tmp, target);
    return target;
  }
}
