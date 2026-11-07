import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { latestRustdeskVersionOr } from './rustdesk-release';

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

  /**
   * The RustDesk client version installers and Connect scripts should use:
   * the platform's supported-version pin when one is set, otherwise the
   * latest release. A pin stops a new upstream release from being picked up
   * by every installer the moment it is published.
   */
  async pinnedOrLatestVersion(): Promise<string> {
    const s = await this.prisma.platformSettings.findUnique({
      where: { id: 'singleton' }, select: { rustdeskPinnedVersion: true },
    }).catch(() => null);
    const pin = s?.rustdeskPinnedVersion;
    if (pin && /^\d+\.\d+\.\d+$/.test(pin)) return pin;
    return latestRustdeskVersionOr();
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

    // Leaves `$pexe` holding the cached, filename-configured client. Used both
    // as the portable fallback and as the installer for an upgrade.
    const fetchExe = this.joinPs([
      `$dir = Join-Path $env:LOCALAPPDATA 'Rem0te'`,
      `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
      `$pexe = Join-Path $dir '${cachedName}'`,
      // Size check as well as existence: a transfer killed part-way leaves a
      // file that exists and cannot run, and the retry would skip it forever.
      // The version check replaces a cached copy left behind by an older
      // release, which would otherwise be "the RustDesk already cached" forever.
      //
      // Independent `if`s rather than if/else: every statement is joined with
      // "; ", and `if (...) { }; else { }` parses as a bare `else`. joinPs()
      // refuses to emit that shape at all.
      `$cached = (Test-Path $pexe) -and ((Get-Item $pexe).Length -gt 20000000)`,
      `if ($cached) { $cv = & $rdVer $pexe; if ($cv -and ($cv -lt [version]'${clientVersion}')) { Write-Host ('Cached RustDesk is ' + $cv + '; fetching ${clientVersion}.'); $cached = $false } }`,
      `if ($cached) { Write-Host 'Using the RustDesk already cached for Rem0te.' }`,
      `if (-not $cached) { ${this.joinPs([
        `Write-Host 'Fetching RustDesk ${clientVersion} (about 25 MB)...'`,
        `$part = $pexe + '.part'`,
        `$ok = $false`,
        `$prev = $ProgressPreference`,
        `$ProgressPreference = 'SilentlyContinue'`,
        `foreach ($u in ${sources}) { try { Invoke-WebRequest -Uri $u -OutFile $part -UseBasicParsing -TimeoutSec 600; $ok = $true; break } catch { } }`,
        `$ProgressPreference = $prev`,
        `if (-not $ok) { Write-Host 'Could not download RustDesk. Check this computer can reach the internet.'; Read-Host 'Press Enter to close'; exit 1 }`,
        `Move-Item -Force $part $pexe`,
      ])} }`,
      // Stale copies from before the name carried the config. They are inert
      // once nothing points at them, but they are 25 MB each.
      `Get-ChildItem -Path $dir -Filter 'rustdesk*.exe' | Where-Object { $_.FullName -ne $pexe } | Remove-Item -Force -ErrorAction SilentlyContinue`,
    ]);

    const usePortable = this.joinPs([
      fetchExe,
      `$rd = $pexe`,
      `$portable = $true`,
    ]);

    return this.joinPs([
      `$portable = $false`,
      // ProductVersion of a RustDesk exe, as a [version], or $null.
      `$rdVer = { param($f) try { [version]((Get-Item -LiteralPath $f -ErrorAction Stop).VersionInfo.ProductVersion -replace '[^0-9.].*$', '') } catch { $null } }`,
      `$paths = @($env:ProgramFiles + '\\RustDesk\\rustdesk.exe', ${'${env:ProgramFiles(x86)}'} + '\\RustDesk\\rustdesk.exe')`,
      `$rd = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1`,
      `if (-not $rd) { $rd = (Get-Command rustdesk.exe -ErrorAction SilentlyContinue).Source }`,
      `if ($rd) { ${this.repairInstalledRustdesk(config, clientVersion, fetchExe)} }`,
      `if (-not $rd) { ${usePortable} }`,
    ]);
  }

  /**
   * PowerShell that brings an installed RustDesk up to date and onto this
   * server and key, or clears `$rd` so the caller falls back to the
   * filename-configured portable copy.
   *
   * Why this exists (2026-11-01, DS-HOME1 "Key mismatch"): hbbs checks the key
   * of the client *making* a connection. The technician's RustDesk had been
   * installed from a download the browser saved as `…key=<key> (1).exe`, so
   * its key was `<key> (1)`. Re-running a newer installer did not help — with
   * RustDesk already running, launching the new exe just hands off to the
   * running instance, so the install stayed at the old version with the old
   * key, and the "portable fallback" handed its connection to that same
   * running instance too.
   *
   * Neither problem can be fixed unelevated. So when the installed client is
   * older than the current release, or its server or key is wrong, one elevated
   * step (a single UAC prompt, and only then) stops RustDesk, runs the
   * filename-configured release with `--silent-install` if an upgrade is due,
   * and rewrites the server settings directly in every RustDesk2.toml that
   * matters — the service's and the user's — rather than trusting
   * `rustdesk --config` and RustDesk's own config sync to get there. Other
   * settings in those files are preserved.
   *
   * The elevated script is built here as ordinary PowerShell, carried as
   * base64 (the .cmd forbids double quotes and percent signs, the elevated
   * body needs both freedoms), and has this user's paths substituted in at
   * run time before it is re-encoded for `-EncodedCommand`.
   */
  private repairInstalledRustdesk(config: RustdeskServerConfig, clientVersion: string, fetchExe: string): string {
    const elevated = RustdeskService.elevatedRepairScript(config, clientVersion);
    const elevatedB64 = Buffer.from(elevated, 'utf8').toString('base64');
    return this.joinPs([
      `$wantKey = '${config.key}'`,
      `$wantHost = '${config.host}'`,
      `$rcfg = Join-Path (Join-Path (Join-Path $env:APPDATA 'RustDesk') 'config') 'RustDesk2.toml'`,
      `$rdir = Join-Path $env:LOCALAPPDATA 'Rem0te'`,
      `New-Item -ItemType Directory -Force -Path $rdir | Out-Null`,
      // Reads `key = '…'` and `custom-rendezvous-server = '…'`. \\x27 and
      // \\x22 stand in for the quote characters, because a double quote
      // cannot appear anywhere in a script that cmd.exe passes through.
      `$readCfg = { $r = @{ key = $null; host = $null; found = $false }; if (Test-Path $rcfg) { $r.found = $true; $t = Get-Content -Raw -LiteralPath $rcfg; if ($t -match '(?m)^\\s*key\\s*=\\s*[\\x27\\x22]([^\\x27\\x22]*)') { $r.key = $Matches[1] }; if ($t -match 'custom-rendezvous-server\\s*=\\s*[\\x27\\x22]([^\\x27\\x22:]*)') { $r.host = $Matches[1] } }; $r }`,
      `$have = & $readCfg`,
      `$good = ($have.key -eq $wantKey) -and ($have.host -eq $wantHost)`,
      `$iv = & $rdVer $rd`,
      `$outdated = (-not $iv) -or ($iv -lt [version]'${clientVersion}')`,
      `Write-Host ('Installed RustDesk: ' + $rd + ' (version ' + $(if ($iv) { $iv } else { 'unknown' }) + ')')`,
      `if ($good -and -not $outdated) { Write-Host 'Installed RustDesk is current and already uses this server and key.' }`,
      `if (-not ($good -and -not $outdated)) { ${this.joinPs([
        `Write-Host ''`,
        `if ($outdated) { Write-Host 'Installed RustDesk is older than ${clientVersion}; it will be upgraded.' }`,
        `if ($have.host -ne $wantHost) { Write-Host ('Installed RustDesk points at ' + $(if ($have.host) { $have.host } else { 'no custom server' }) + ', not ' + $wantHost + '.') }`,
        `if ($have.key -ne $wantKey) { Write-Host 'Installed RustDesk has a different server key (this is what causes Key mismatch).' }`,
        `$pexe = $null`,
        `if ($outdated) { ${fetchExe} }`,
        `$result = Join-Path $rdir 'repair-result.txt'`,
        `Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue`,
        `$q = [string][char]39`,
        `$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${elevatedB64}'))`,
        `$body = $body.Replace('__APPDATA__', $env:APPDATA.Replace($q, $q + $q)).Replace('__RESULT__', $result.Replace($q, $q + $q)).Replace('__EXE__', $(if ($pexe) { $pexe.Replace($q, $q + $q) } else { '' }))`,
        `$enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))`,
        `Write-Host 'Repairing it now - Windows will ask for administrator permission once.'`,
        `$applied = $false`,
        `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc -Verb RunAs -WindowStyle Hidden -PassThru; $applied = $p.WaitForExit(300000) } catch { Write-Host 'Administrator permission was not given.' }`,
        `$res = $(if (Test-Path $result) { (Get-Content -Raw -LiteralPath $result).Trim() } else { '' })`,
        `$have = & $readCfg`,
        `$iv = & $rdVer $rd`,
        `$ok = $applied -and ($res -like 'ok*') -and ($have.key -eq $wantKey) -and ($have.host -eq $wantHost)`,
        `if ($ok) { Write-Host ('Installed RustDesk repaired (version ' + $iv + ', server ' + $wantHost + ', key ok).') }`,
        `if ($ok -and ($iv -lt [version]'${clientVersion}')) { Write-Host 'WARNING: the upgrade did not take; connecting with the existing version.' }`,
        `if ($applied -and -not $ok) { Write-Host ('Repair did not complete: ' + $(if ($res) { $res } else { 'no result' }) + '. Details: ' + (Join-Path $rdir 'repair.log')) }`,
        `if (-not $ok) { Write-Host 'Using a separate copy configured for this server instead.'; Write-Host 'If RustDesk is running in the system tray, quit it first, or the session may still use the old settings.'; $rd = $null }`,
      ])} }`,
    ]);
  }

  /**
   * The elevated half of {@link repairInstalledRustdesk}: ordinary PowerShell,
   * run via `-EncodedCommand`. `__APPDATA__`, `__EXE__` and `__RESULT__` are
   * substituted (single quotes already doubled) by the unelevated caller.
   */
  static elevatedRepairScript(config: RustdeskServerConfig, clientVersion: string): string {
    const H = config.host;
    const K = config.key;
    return [
      `$ErrorActionPreference = 'Continue'`,
      `$result = '__RESULT__'`,
      `$log = Join-Path (Split-Path $result -Parent) 'repair.log'`,
      `function L($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + ' ' + $m) } catch {} }`,
      `function Done($m) { L $m; try { Set-Content -LiteralPath $result -Value $m -Encoding ASCII } catch {} }`,
      `$RDEXE = Join-Path $env:ProgramFiles 'RustDesk\\rustdesk.exe'`,
      `$exe = '__EXE__'`,
      `function RdVer { try { [version]((Get-Item -LiteralPath $RDEXE -ErrorAction Stop).VersionInfo.ProductVersion -replace '[^0-9.].*$', '') } catch { $null } }`,
      `function Stop-Rd { & sc.exe stop RustDesk 2>$null | Out-Null; & taskkill /F /IM rustdesk.exe /T 2>$null | Out-Null; Start-Sleep -Seconds 2 }`,
      `L ('repair start; installed ' + (RdVer) + '; installer ' + $exe)`,
      `Stop-Rd`,
      `if ($exe -and (Test-Path -LiteralPath $exe)) {`,
      `    $want = [version]'${clientVersion}'`,
      // --silent-install: RustDesk's exe has no /S switch.
      `    $p = Start-Process -FilePath $exe -ArgumentList '--silent-install' -PassThru -WindowStyle Hidden`,
      `    $p.WaitForExit(180000) | Out-Null`,
      `    $waited = 0`,
      // Wait for RustDesk's installer to finish recreating the service as
      // --service; stopping it earlier strands the one-shot --import-config.
      `    while ($waited -lt 180) { $v = RdVer; $sp = (Get-CimInstance Win32_Service -Filter "Name='RustDesk'" -ErrorAction SilentlyContinue).PathName; if ($v -and $v -ge $want -and $sp -match '--service') { break }; Start-Sleep -Seconds 3; $waited += 3 }`,
      `    L ('service after install: ' + $sp)`,
      `    L ('after install: ' + (RdVer))`,
      `    Stop-Rd`,
      `}`,
      // Rewrite only the server lines; keep every other setting the file has.
      `function Set-RdCfg($dir) {`,
      `    try {`,
      `        New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
      `        $file = Join-Path $dir 'RustDesk2.toml'`,
      `        $lines = @()`,
      `        if (Test-Path -LiteralPath $file) { $lines = @(Get-Content -LiteralPath $file) }`,
      `        $lines = @($lines | Where-Object { $_ -notmatch '^\\s*(key|custom-rendezvous-server|relay-server|api-server|rendezvous_server)\\s*=' })`,
      `        $opts = @("custom-rendezvous-server = '${H}'", "relay-server = '${H}'", "api-server = ''", "key = '${K}'")`,
      `        $idx = -1`,
      `        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\\s*\\[options\\]\\s*$') { $idx = $i; break } }`,
      `        $head = @("rendezvous_server = '${H}:21116'")`,
      `        if ($idx -lt 0) { $out = $head + $lines + @('', '[options]') + $opts }`,
      `        else {`,
      `            $before = @($lines[0..$idx])`,
      `            $after = @(); if ($idx -lt $lines.Count - 1) { $after = @($lines[($idx + 1)..($lines.Count - 1)]) }`,
      `            $out = $head + $before + $opts + $after`,
      `        }`,
      `        Set-Content -LiteralPath $file -Value $out -Encoding UTF8 -Force`,
      `        L ('wrote ' + $file)`,
      `        return $true`,
      `    } catch { L ('FAILED ' + $dir + ': ' + $_.Exception.Message); return $false }`,
      `}`,
      `$dirs = @(`,
      `    'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\RustDesk\\config',`,
      `    'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Roaming\\RustDesk\\config',`,
      `    (Join-Path '__APPDATA__' 'RustDesk\\config')`,
      `)`,
      `$allOk = $true`,
      `foreach ($d in $dirs) { if (-not (Set-RdCfg $d)) { $allOk = $false } }`,
      `$svc = Get-CimInstance Win32_Service -Filter "Name='RustDesk'" -ErrorAction SilentlyContinue`,
      `$svcWant = '"' + $RDEXE + '" --service'`,
      `if (-not $svc) { try { New-Service -Name 'RustDesk' -BinaryPathName $svcWant -DisplayName 'RustDesk Service' -StartupType Automatic -ErrorAction Stop | Out-Null; L 'created service' } catch { L ('could not create service: ' + $_.Exception.Message) } }`,
      `if ($svc -and $svc.PathName -notmatch '--service') { $r = Invoke-CimMethod -InputObject $svc -MethodName Change -Arguments @{ PathName = $svcWant; StartMode = 'Automatic' }; L ('service was ' + $svc.PathName + '; reset (' + $r.ReturnValue + ')') }`,
      `& sc.exe start RustDesk 2>$null | Out-Null`,
      `if ($allOk) { Done ('ok ' + (RdVer)) } else { Done 'failed to write some config files' }`,
    ].join('\r\n');
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
   * The script is NOT on the command line. It sits after the batch part's
   * last line, under a marker, and PowerShell reads it back out of this very
   * file. cmd.exe refuses any line over 8191 characters ("The input line is
   * too long") and closes the window at once; 0.19.8's Connect script was
   * ~11,600 characters on one `powershell -Command` line and died exactly
   * that way, too fast to read. Batch parsing stops at `exit /b`, so cmd never
   * sees the script lines at all.
   *
   * The body still contains no double quotes and no percent signs, as a
   * margin, and everything interpolated into it is a constrained charset
   * (hostname, base64, numeric peer id) or base64-encoded first.
   */
  private wrapCmd(title: string, comments: string[], ps: string, selfDelete: boolean): string {
    if ([...ps].some((ch) => ch.charCodeAt(0) > 0x7e || (ch.charCodeAt(0) < 0x20 && !'\t\r\n'.includes(ch)))) {
      // Windows PowerShell reads the file in the ANSI code page.
      throw new Error('Connect .cmd PowerShell body must be ASCII');
    }
    if (ps.includes(RustdeskService.PS_MARKER)) {
      throw new Error('PowerShell body contains the script marker');
    }
    // The marker is split in the loader so the only full occurrence in the
    // file is the real one.
    const half = RustdeskService.PS_MARKER.length / 2;
    const m1 = RustdeskService.PS_MARKER.slice(0, half);
    const m2 = RustdeskService.PS_MARKER.slice(half);
    const loader =
      `$t = [IO.File]::ReadAllText($env:REM0TE_SELF); ` +
      `$m = '${m1}' + '${m2}'; ` +
      `$i = $t.LastIndexOf($m); ` +
      `if ($i -lt 0) { Write-Host 'Script body missing from this file.'; exit 1 }; ` +
      `Invoke-Expression $t.Substring($i + $m.Length)`;
    const lines = [
      '@echo off',
      `title ${title}`,
      'rem',
      ...comments.map((c) => (c ? `rem  ${c}` : 'rem')),
      'rem',
      'set "REM0TE_SELF=%~f0"',
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${loader}"`,
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
    // cmd.exe's hard limit is 8191 characters per line; fail the build long
    // before that rather than ship a script that closes on launch.
    const long = lines.find((l) => l.length > 2000);
    if (long) throw new Error(`Batch line too long for cmd.exe (${long.length} chars): ${long.slice(0, 60)}`);
    // Batch execution must never reach the script lines below.
    lines.push('exit /b', RustdeskService.PS_MARKER, ps, '');
    // CRLF: a .cmd with bare LF endings loses the last token of every line.
    return lines.join('\r\n');
  }

  private static readonly PS_MARKER = '::REM0TE-PS-BODY::';

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
    /** Per-session telemetry: where to report, and the token bound to that session. */
    telemetry?: { url: string; token: string } | null;
  }): string {
    const { config, password, clientDownloadUrl, clientVersion } = opts;
    // The URL and token land inside single-quoted PowerShell in a body that
    // must contain no double quote or percent sign; anything outside a plain
    // URL charset (or a non-hex token) and the script simply does not report.
    const tel = opts.telemetry && /^https?:\/\/[A-Za-z0-9.:_/-]+$/.test(opts.telemetry.url) && /^[0-9a-f]{48}$/.test(opts.telemetry.token)
      ? opts.telemetry : null;
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
      // Best-effort progress reports for THIS session (see SessionEventsService
      // .recordScriptTelemetry). Bounded at 5 s and never fatal: a technician
      // waiting on Connect must not wait on bookkeeping.
      tel
        ? `$tel = { param($e, $d) try { $b = @{ token = '${tel.token}'; event = $e; detail = [string]$d } | ConvertTo-Json -Compress; Invoke-RestMethod -Uri '${tel.url}' -Method Post -Body $b -ContentType 'application/json' -TimeoutSec 5 -UseBasicParsing | Out-Null } catch { } }`
        : `$tel = { param($e, $d) }`,
      `& $tel 'launcher_acknowledged' ''`,
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
      // "Client opened" means exactly this: the RustDesk process was started.
      // It is not a connection — the remote computer's agent is what reports
      // that (session-state.ts).
      `try { $proc = Start-Process -FilePath $rd -ArgumentList $uri -PassThru -ErrorAction Stop; & $tel 'client_opened' ([string]$proc.Id) } catch { & $tel 'client_launch_failed' ([string]$_.Exception.Message); throw }`,
      `Write-Host 'RustDesk should be opening now. Rem0te will show the session as connected once the remote computer reports it.'`,
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
   * A READ-ONLY check of this technician's own computer, as a .cmd.
   *
   * A browser cannot inspect local configuration, and the Tauri launcher is
   * not on every technician's machine, so the existing Connect-script
   * mechanism is the local helper: same wrapper, same no-double-quote /
   * no-percent / ASCII rules. It changes nothing, needs no elevation, starts
   * no session, and reports back with a single-use token minted for this
   * user. It sends the server address it found and whether the key MATCHES
   * — never the key itself, nor any password.
   */
  buildTechnicianCheckCmd(opts: { config: RustdeskServerConfig; reportUrl: string; token: string; expectedVersion: string }): string {
    const { config, token } = opts;
    if (!/^https?:\/\/[A-Za-z0-9.:_/-]+$/.test(opts.reportUrl)) throw new Error('Report URL is not a plain URL');
    if (!/^[0-9a-f]{48}$/.test(token)) throw new Error('Bad diagnostic token');
    const keyB64 = Buffer.from(config.key, 'utf8').toString('base64');
    const ps = this.withErrorReporting(this.joinPs([
      `Write-Host 'Rem0te technician check - read-only. Nothing on this computer is changed.'`,
      `Write-Host ''`,
      `$wantHost = '${config.host}'`,
      `$wantKey = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${keyB64}'))`,
      `$r = [ordered]@{}`,
      `$r.collectedAt = (Get-Date).ToUniversalTime().ToString('o')`,
      `$r.os = [string][Environment]::OSVersion.VersionString`,
      `$rdVer = { param($f) try { [string]((Get-Item -LiteralPath $f -ErrorAction Stop).VersionInfo.ProductVersion -replace '[^0-9.].*$', '') } catch { '' } }`,
      `$paths = @($env:ProgramFiles + '\\RustDesk\\rustdesk.exe', ${'${env:ProgramFiles(x86)}'} + '\\RustDesk\\rustdesk.exe')`,
      `$inst = $paths | Where-Object { Test-Path $_ } | Select-Object -First 1`,
      `$r.installed = [bool]$inst`,
      `$r.installedPath = [string]$inst`,
      `$r.installedVersion = $(if ($inst) { & $rdVer $inst } else { '' })`,
      `$pdir = Join-Path $env:LOCALAPPDATA 'Rem0te'`,
      `$pexe = Get-ChildItem -Path $pdir -Filter 'rustdesk*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1`,
      `$r.portableCached = [bool]$pexe`,
      `$r.portableVersion = $(if ($pexe) { & $rdVer $pexe.FullName } else { '' })`,
      `$svc = Get-Service -Name 'RustDesk' -ErrorAction SilentlyContinue`,
      `$r.serviceStatus = $(if ($svc) { [string]$svc.Status } else { 'absent' })`,
      `$r.runningProcesses = @(Get-Process -Name 'rustdesk' -ErrorAction SilentlyContinue).Count`,
      `$cfg = Join-Path (Join-Path (Join-Path $env:APPDATA 'RustDesk') 'config') 'RustDesk2.toml'`,
      `$r.configFound = Test-Path -LiteralPath $cfg`,
      `$haveKey = $null`,
      `$r.configHost = ''`,
      `if ($r.configFound) { $t = Get-Content -Raw -LiteralPath $cfg; if ($t -match '(?m)^\\s*key\\s*=\\s*[\\x27\\x22]([^\\x27\\x22]*)') { $haveKey = $Matches[1] }; if ($t -match 'custom-rendezvous-server\\s*=\\s*[\\x27\\x22]([^\\x27\\x22:]*)') { $r.configHost = $Matches[1] } }`,
      `$r.hostMatches = ($r.configHost -eq $wantHost)`,
      `$r.keyPresent = [bool]$haveKey`,
      `$r.keyMatches = ($haveKey -eq $wantKey)`,
      `$r.protocolHandler = Test-Path -LiteralPath 'Registry::HKEY_CLASSES_ROOT\\rustdesk'`,
      `$probe = { param($p) $c = New-Object System.Net.Sockets.TcpClient; try { $a = $c.BeginConnect($wantHost, $p, $null, $null); $ok = $a.AsyncWaitHandle.WaitOne(3000); if ($ok) { $c.EndConnect($a) }; $ok -and $c.Connected } catch { $false } finally { $c.Close() } }`,
      `$r.tcp21116 = & $probe 21116`,
      `$r.tcp21117 = & $probe 21117`,
      `Write-Host ('Installed RustDesk : ' + $(if ($r.installed) { $r.installedPath + ' ' + $r.installedVersion } else { 'none' }))`,
      `Write-Host ('Portable copy      : ' + $(if ($r.portableCached) { $r.portableVersion } else { 'none' }))`,
      `Write-Host ('Server in config   : ' + $(if ($r.configHost) { $r.configHost } else { 'none' }) + $(if ($r.hostMatches) { ' (correct)' } else { ' (expected ' + $wantHost + ')' }))`,
      `Write-Host ('Server key         : ' + $(if (-not $r.keyPresent) { 'not set' } elseif ($r.keyMatches) { 'matches' } else { 'DOES NOT MATCH' }))`,
      `Write-Host ('Reach ' + $wantHost + ' 21116/21117 : ' + $r.tcp21116 + ' / ' + $r.tcp21117)`,
      `$b = @{ token = '${token}'; report = $r } | ConvertTo-Json -Compress -Depth 4`,
      `try { Invoke-RestMethod -Uri '${opts.reportUrl}' -Method Post -Body $b -ContentType 'application/json' -TimeoutSec 15 -UseBasicParsing | Out-Null; Write-Host ''; Write-Host 'Report sent. Go back to Rem0te and press Refresh on the Test Connection panel.' } catch { Write-Host ''; Write-Host ('Could not send the report: ' + $_.Exception.Message) }`,
      `Read-Host 'Press Enter to close'`,
    ]));
    return this.wrapCmd('Rem0te - technician check', [
      'Rem0te technician-side connection check.',
      '',
      'READ-ONLY: looks at the RustDesk installed on this computer, its',
      'server settings, and whether this computer can reach the Rem0te',
      'server ports. Changes nothing, starts no session, needs no admin.',
      'Sends the result to Rem0te with a single-use token.',
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
