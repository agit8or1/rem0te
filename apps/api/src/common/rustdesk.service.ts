import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
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
const PEER_ID_RE = /^[A-Za-z0-9_-]{6,32}$/;

export interface RustdeskServerConfig {
  host: string;
  key: string;
  /**
   * `host=…,key=…,api=,relay=…,` — the argument to `rustdesk --config`.
   *
   * Plain text, NOT base64. RustDesk 1.4's `--config` hands its argument to
   * `get_custom_server_from_string()`, which only understands two shapes: a
   * string containing `host=`, or a *reversed* base64 JSON licence. Until
   * 0.19.7 every caller sent plain base64 of this string, which matches
   * neither, so `--config` parsed nothing and silently changed nothing — on
   * every installer run, every launcher Connect and every setup.cmd.
   *
   * `--config` is also ignored unless the process is elevated *and* RustDesk
   * is installed ("Installation and administrative privileges required!"),
   * which is why Connect elevates it explicitly when a repair is needed.
   */
  configArg: string;
  /**
   * The executable name RustDesk configures itself from:
   * `rustdesk-host=<host>,key=<key>,.exe`.
   *
   * The trailing comma is load-bearing. A browser that already has the file
   * saves the next copy as `… (1).exe`, and RustDesk splits the name on
   * commas: without the comma the key becomes `<key> (1)`, the installer
   * writes that into the config, and hbbs rejects every connection the
   * client makes with "Key mismatch". With it, ` (1)` is an empty trailing
   * token RustDesk ignores.
   */
  exeName: string;
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

    return {
      host,
      key,
      configArg: `host=${host},key=${key},api=,relay=${host},`,
      exeName: RustdeskService.configuredExeName(host, key),
    };
  }

  /** See {@link RustdeskServerConfig.exeName} for why it ends in `,.exe`. */
  static configuredExeName(host: string, key: string): string {
    return `rustdesk-host=${host},key=${key},.exe`;
  }
  /**
   * Join PowerShell statements with "; ", refusing anything the join would
   * silently corrupt.
   *
   * A semicolon terminates a statement, so a continuation keyword that starts
   * its own element stops being a continuation. `if (...) { }` and
   * `else { }` as two elements become `if (...) { }; else { }`, and PowerShell
   * reports the perfectly accurate but thoroughly unhelpful "The term 'else'
   * is not recognized as the name of a cmdlet". Shipped exactly that once.
   *
   * Brace balance does not catch it — the braces balance fine. This does, at
   * build time, in a place with a stack trace, instead of in a console window
   * on someone else's machine. Any statement needing a continuation keyword
   * must be built as a single element with its keyword inline.
   */
  private joinPs(statements: string[]): string {
    const CONTINUATIONS = /^(else|elseif|catch|finally|until)\b/;
    for (const stmt of statements) {
      if (CONTINUATIONS.test(stmt.trim())) {
        throw new Error(
          `PowerShell statement starts with a continuation keyword and would be ` +
          `orphaned by the "; " join: ${stmt.slice(0, 60)}. Build it as one ` +
          `statement with its if/try inline.`,
        );
      }
    }
    return statements.join('; ');
  }

  /**
   * PowerShell that leaves `$rd` holding a runnable rustdesk.exe.
   *
   * Three tiers, cheapest first:
   *
   *  1. An installed RustDesk. Costs nothing.
   *  2. A portable copy cached under %LOCALAPPDATA%\Rem0te. Costs nothing
   *     after the first time.
   *  3. Download one, into that cache.
   *
   * It does not install anything, which is both faster and the fix for a real
   * hang: the previous version ran the setup executable with
   * `Start-Process -Wait -ArgumentList '--silent-install'`, and installing
   * RustDesk needs elevation. From a non-elevated shell that blocks on a UAC
   * prompt behind the console window — the script simply sat at "Installing
   * RustDesk..." forever. RustDesk runs perfectly well from a folder, so
   * there was never a reason to install it to open a session.
   *
   * `$ProgressPreference = 'SilentlyContinue'` around the download is not
   * cosmetic. Invoke-WebRequest renders a progress bar per chunk, and for a
   * ~24 MB file that redraw costs far more than the transfer does — this is
   * the single biggest factor in how long the first run takes.
   *
   * Backslashes are doubled deliberately. A template literal turns `\R` into a
   * bare `R`, which would search for `RustDeskrustdesk.exe`. Same class of bug
   * as `\U` in `C:\Users` — see the header of public.controller.ts.
   */
  private findOrFetchRustdesk(config: RustdeskServerConfig, clientVersion: string, clientDownloadUrl: string): string {
    const githubUrl =
      `https://github.com/rustdesk/rustdesk/releases/download/${clientVersion}/rustdesk-${clientVersion}-x86_64.exe`;

    // Our own server first so a site with restricted egress still works, then
    // GitHub. The two builds are interchangeable — what configures the copy is
    // the name we save it under, not which URL it came from.
    const sources = `@('${clientDownloadUrl}', '${githubUrl}')`;

    // Config in the filename, which is what actually works.
    //
    // RustDesk parses its own executable name for `host=` and `key=` at
    // startup. This is the mechanism Quick Connect has always used, and it is
    // the one with field evidence behind it: the first client this script
    // produced registered with our hbbs and paired a relay session.
    //
    // Two later attempts to configure a copy some other way — `--config`, then
    // writing RustDesk2.toml directly — both left the client still talking to
    // rustdesk.com, reporting a healthy endpoint as "offline or does not
    // exist". Neither failed loudly. Use the mechanism that demonstrably
    // works rather than the one that looks tidier.
    const cachedName = config.exeName;

    const fetch = this.joinPs([
      `$dir = Join-Path $env:LOCALAPPDATA 'Rem0te'`,
      `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
      `$rd = Join-Path $dir '${cachedName}'`,
      // Size check as well as existence: a transfer killed part-way leaves a
      // file that exists and cannot run, and the retry would skip it forever.
      //
      // Two independent `if`s rather than if/else. Every statement here is
      // joined with "; ", and a semicolon terminates an if-statement — so
      // `if (...) { }; else { }` parses as a bare `else`, which PowerShell
      // reports as "The term 'else' is not recognized as the name of a
      // cmdlet". joinPs() refuses to emit that shape at all.
      `$cached = (Test-Path $rd) -and ((Get-Item $rd).Length -gt 20000000)`,
      `if ($cached) { Write-Host 'Using the RustDesk already cached for Rem0te.' }`,
      `if (-not $cached) { ${this.joinPs([
        `Write-Host 'Fetching RustDesk (one time, about 24 MB)...'`,
        `$part = $rd + '.part'`,
        `$ok = $false`,
        `$prev = $ProgressPreference`,
        `$ProgressPreference = 'SilentlyContinue'`,
        `foreach ($u in ${sources}) { try { Invoke-WebRequest -Uri $u -OutFile $part -UseBasicParsing -TimeoutSec 600; $ok = $true; break } catch { } }`,
        `$ProgressPreference = $prev`,
        `if (-not $ok) { Write-Host 'Could not download RustDesk. Check this computer can reach the internet.'; Read-Host 'Press Enter to close'; exit 1 }`,
        `Move-Item -Force $part $rd`,
      ])} }`,
      // Stale copies from before the name carried the config. They are inert
      // once nothing points at them, but they are 24 MB each.
      `Get-ChildItem -Path $dir -Filter 'rustdesk*.exe' | Where-Object { $_.FullName -ne $rd } | Remove-Item -Force -ErrorAction SilentlyContinue`,
      // The name is the configuration, so a client that was previously left
      // pointing somewhere else must not keep overriding it from disk.
      `$stale = Join-Path (Join-Path (Join-Path $env:APPDATA 'RustDesk') 'config') 'RustDesk2.toml'`,
      `if (Test-Path $stale) { Remove-Item -Force $stale -ErrorAction SilentlyContinue; Write-Host 'Cleared a previous RustDesk server setting.' }`,
      `$portable = $true`,
    ]);

    return this.joinPs([
      `$portable = $false`,
      `$paths = @($env:ProgramFiles + '\\RustDesk\\rustdesk.exe', ${'${env:ProgramFiles(x86)}'} + '\\RustDesk\\rustdesk.exe')`,
      `$rd = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1`,
      `if (-not $rd) { $rd = (Get-Command rustdesk.exe -ErrorAction SilentlyContinue).Source }`,
      `if ($rd) { ${this.repairInstalledRustdesk(config)} }`,
      `if (-not $rd) { ${fetch} }`,
    ]);
  }

  /**
   * PowerShell that makes an installed RustDesk use this server and key, or
   * clears `$rd` so the caller falls back to the filename-configured copy.
   *
   * An installed client keeps whatever server settings it was installed with,
   * and reinstalling does not necessarily fix them: RustDesk's installer
   * copies the key out of its own filename, so a download the browser saved
   * as `rustdesk-host=…,key=<key> (1).exe` installs with the key
   * `<key> (1)` — and every Connect after that ends in "Key mismatch", which
   * is hbbs refusing the *technician's* client, not the endpoint. That is how
   * DS-HOME1 "broke" after a reinstall on 2026-11-01.
   *
   * The only supported way to rewrite an installed client's settings is
   * `rustdesk --config`, and RustDesk ignores it unless it runs elevated. So:
   * read the settings the client's session copy reports (RustDesk syncs the
   * service config into the user's RustDesk2.toml), and only when they are
   * wrong, ask for elevation once and apply them. Nothing is prompted for a
   * client that is already right. A marker in %LOCALAPPDATA%\\Rem0te records a
   * successful repair, so a machine whose session copy never materialises is
   * not prompted on every Connect.
   */
  private repairInstalledRustdesk(config: RustdeskServerConfig): string {
    return this.joinPs([
      `$wantKey = '${config.key}'`,
      `$wantHost = '${config.host}'`,
      `$rcfg = Join-Path (Join-Path (Join-Path $env:APPDATA 'RustDesk') 'config') 'RustDesk2.toml'`,
      `$rdir = Join-Path $env:LOCALAPPDATA 'Rem0te'`,
      `New-Item -ItemType Directory -Force -Path $rdir | Out-Null`,
      `$marker = Join-Path $rdir 'installed-rustdesk-config.txt'`,
      // Reads `key = '…'` and `custom-rendezvous-server = '…'`. \\x27 and
      // \\x22 stand in for the quote characters, because a double quote
      // cannot appear anywhere in a script that cmd.exe passes through.
      `$readCfg = { $r = @{ key = $null; host = $null; found = $false }; if (Test-Path $rcfg) { $r.found = $true; $t = Get-Content -Raw -LiteralPath $rcfg; if ($t -match '(?m)^\\s*key\\s*=\\s*[\\x27\\x22]([^\\x27\\x22]*)') { $r.key = $Matches[1] }; if ($t -match 'custom-rendezvous-server\\s*=\\s*[\\x27\\x22]([^\\x27\\x22:]*)') { $r.host = $Matches[1] } }; $r }`,
      `$have = & $readCfg`,
      `$good = ($have.key -eq $wantKey) -and ($have.host -eq $wantHost)`,
      `$marked = (-not $have.found) -and (Test-Path $marker) -and ((Get-Content -Raw -LiteralPath $marker).Trim() -eq '${config.configArg}')`,
      `if ($good -or $marked) { Write-Host 'Installed RustDesk already uses this server and key.' }`,
      `if (-not ($good -or $marked)) { ${this.joinPs([
        `Write-Host ''`,
        `if ($have.host -ne $wantHost) { Write-Host ('Installed RustDesk points at ' + $(if ($have.host) { $have.host } else { 'no custom server' }) + ', not ' + $wantHost + '.') }`,
        `if ($have.key -ne $wantKey) { Write-Host 'Installed RustDesk has a different server key (this is what causes Key mismatch).' }`,
        `Write-Host 'Repairing it now - Windows will ask for administrator permission once.'`,
        `$applied = $false`,
        `try { $p = Start-Process -FilePath $rd -ArgumentList '--config', '${config.configArg}' -Verb RunAs -WindowStyle Hidden -PassThru; $applied = $p.WaitForExit(20000) } catch { Write-Host 'Administrator permission was not given.' }`,
        // The new setting reaches the session copy through RustDesk's own
        // config sync, which is not instant.
        `if ($applied) { Start-Sleep -Seconds 3; $have = & $readCfg }`,
        `$ok = $applied -and ((-not $have.found) -or (($have.key -eq $wantKey) -and ($have.host -eq $wantHost)))`,
        `if ($ok) { Set-Content -LiteralPath $marker -Value '${config.configArg}' -Encoding ASCII; Write-Host 'Installed RustDesk now uses this server and key.' }`,
        `if (-not $ok) { Write-Host 'Could not repair the installed RustDesk; using a separate copy configured for this server instead.'; Write-Host 'If RustDesk is running in the system tray, quit it first, or the session may still use the old settings.'; Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue; $rd = $null }`,
      ])} }`,
    ]);
  }

  /**
   * Wrap a script body so a failure is readable after the fact.
   *
   * `$ErrorActionPreference = 'Stop'` turns any failure into a terminating
   * error, PowerShell exits, and the .cmd — which deletes itself — closes the
   * window in the same instant. The result is a script that "runs, errors out
   * and closes before you can read the error", which is the worst possible
   * outcome: it looks identical to doing nothing.
   *
   * So: a transcript to a file that outlives the window, a catch that prints
   * the message and waits, and the log path echoed either way. The transcript
   * is best-effort because Start-Transcript is unavailable under constrained
   * language mode, and a missing log should not itself become the failure.
   *
   * Join-Path is nested rather than passed a `Rem0te\\file.log` literal because
   * a template literal turns `\\R` into a bare `R` — the same trap as `\\U` in
   * `C:\\Users`.
   */
  private withErrorReporting(body: string): string {
    return this.joinPs([
      `$ErrorActionPreference = 'Stop'`,
      `$dir = Join-Path $env:LOCALAPPDATA 'Rem0te'`,
      `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
      `$log = Join-Path $dir 'rem0te-last-run.log'`,
      `try { Start-Transcript -Path $log -Force | Out-Null } catch { }`,
      `try { ${body} } catch { ${this.joinPs([
        `Write-Host ''`,
        `Write-Host ('ERROR: ' + $_.Exception.Message)`,
        // Deliberately NOT $_.InvocationInfo.Line: the whole script is a
        // single line, so printing it would put the endpoint's password into
        // the console and into the transcript file. The category and the
        // failing command name locate the fault without that.
        `Write-Host ('  where: ' + $_.CategoryInfo.Category + ' in ' + $_.CategoryInfo.Activity)`,
        `Write-Host ''`,
        `Write-Host ('A full log was saved to ' + $log)`,
        `try { Stop-Transcript | Out-Null } catch { }`,
        `Read-Host 'Press Enter to close'`,
        `exit 1`,
      ])} }`,
      `try { Stop-Transcript | Out-Null } catch { }`,
    ]);
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
      'rem  Hold the window open on failure. Without this the script reports an',
      'rem  error and closes in the same instant, which is indistinguishable',
      'rem  from it doing nothing at all.',
      'if errorlevel 1 (',
      '  echo.',
      '  pause',
      ')',
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

  /** Letters, digits, dot, underscore, hyphen and space — inert in cmd.exe and PowerShell alike. */
  static cmdSafe(value: string): string {
    return String(value ?? '').replace(/[^A-Za-z0-9._ -]/g, '-').slice(0, 60);
  }

  /**
   * Point this computer's RustDesk at this server, fetching one if needed.
   *
   * The fetch is not a nicety. The first version of this printed "RustDesk is
   * not installed, download the preconfigured client instead" and stopped — a
   * dead end handed to someone who came here precisely because their remote
   * support was broken. If the fix is "get a client and configure it", the
   * script can do both.
   */
  buildSetupCmd(config: RustdeskServerConfig, clientVersion: string, clientDownloadUrl: string): string {
    const ps = this.withErrorReporting([
      this.findOrFetchRustdesk(config, clientVersion, clientDownloadUrl),
      `Write-Host ('Pointing ' + $rd + ' at ${config.host} ...')`,
      `Write-Host ('Using ' + $rd)`,
      // A fetched copy is configured by its filename; an installed one was
      // checked and, if needed, repaired with an elevated `--config` inside
      // findOrFetchRustdesk(). Nothing further to apply here.
      `Write-Host ''`,
      `Write-Host ('Done. RustDesk at ' + $rd + ' now uses ${config.host}.')`,
      `Write-Host 'Close RustDesk if it is open, then use Connect in Rem0te.'`,
      `Read-Host 'Press Enter to close'`,
    ].join('; '));

    return this.wrapCmd('Rem0te - set up RustDesk', [
      `Points this computer's RustDesk at ${config.host}, fetching a`,
      'portable copy into %LOCALAPPDATA%\\Rem0te first if there is none.',
      'Nothing is installed.',
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
   * So Connect hands over this instead: find RustDesk — or fetch a portable
   * copy and cache it — point it at this server, open the session. It assumes
   * nothing about the machine it runs on, which is the whole point, and it
   * installs nothing, so it needs no elevation and no UAC prompt.
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
    const { config, password, clientDownloadUrl, clientVersion } = opts;
    // Both of these come from the device: the hostname a machine reports about
    // itself and the RustDesk ID it registered with. They reach a `title` line
    // and `rem` comments, which cmd.exe parses for `&`, `|`, `^` and `%`, and
    // single-quoted PowerShell strings, which a `'` terminates. A hostile
    // enrolled machine that called itself `PC&powershell -e ...` ran that
    // payload as whichever technician next clicked Connect. Reduce both to a
    // charset with no metacharacter in either language rather than escaping,
    // because the two languages escape differently and one line feeds both.
    const endpointName = RustdeskService.cmdSafe(opts.endpointName) || 'computer';
    const peerId = RustdeskService.cmdSafe(opts.peerId).replace(/ /g, '');
    if (!PEER_ID_RE.test(peerId)) {
      throw new BadRequestException('This computer has no valid RustDesk ID to connect to.');
    }
    const pwB64 = Buffer.from(password ?? '', 'utf8').toString('base64');

    const ps = this.withErrorReporting([
      `$peer = '${peerId}'`,
      `$pw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pwB64}'))`,
      this.findOrFetchRustdesk(config, clientVersion, clientDownloadUrl),
      `Write-Host 'Pointing RustDesk at ${config.host} ...'`,
      `Write-Host ('Using ' + $rd)`,
      // A fetched copy is configured by its filename. An installed one was
      // checked in findOrFetchRustdesk() and repaired with an elevated
      // `--config` if its server or key was wrong — the unelevated `--config`
      // that used to run here was always a no-op (RustDesk requires admin for
      // it, and was also being handed a base64 form it cannot parse).
      `if ($portable) { Write-Host 'Configured by filename; no reconfiguration needed.' }`,
      // The config lands via IPC when a client is already running; give it a
      // moment before the connection request or that request uses the previous
      // server.
      `Start-Sleep -Seconds 2`,
      `$uri = 'rustdesk://connection/new/' + $peer`,
      `if ($pw) { $uri = $uri + '?password=' + [Uri]::EscapeDataString($pw) }`,
      // Clipboard as a fallback: if this build ignores the password in the URI
      // and prompts, a paste is the difference between working and not.
      `if ($pw) { try { Set-Clipboard -Value $pw } catch { } }`,
      `Write-Host ('Connecting to ${endpointName} (' + $peer + ') ...')`,
      // Hand the URI to *this* executable rather than Start-Process'ing it as
      // a protocol link. The link form goes through the registered rustdesk://
      // handler, which only exists if RustDesk was installed — and the whole
      // point of the cached portable copy is that it was not.
      `Start-Process -FilePath $rd -ArgumentList $uri`,
      `Write-Host 'RustDesk should be opening now.'`,
    ].join('; '));

    return this.wrapCmd(`Rem0te - connect to ${endpointName}`, [
      `Rem0te one-click connect: ${endpointName} (${peerId})`,
      '',
      'Uses the RustDesk already on this computer. If there is none it',
      'fetches a portable copy once into %LOCALAPPDATA%\\Rem0te and reuses',
      'it every time after. Nothing is installed.',
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
