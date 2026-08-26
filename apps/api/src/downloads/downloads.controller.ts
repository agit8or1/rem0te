import {
  Controller, Get, Res, ServiceUnavailableException,
} from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import { RustdeskService, type RustdeskServerConfig } from '../common/rustdesk.service';
import { latestRustdeskVersionOr } from '../common/rustdesk-release';

/**
 * Client downloads for the people doing the supporting.
 *
 * Quick Connect covers the other direction — it hands an unattended customer a
 * client that configures itself. Nothing covered the technician's own machine,
 * and that gap is what made Connect look broken: every Connect button in the
 * app opens `rustdesk://connection/new/<id>`, which Windows routes to whatever
 * RustDesk is installed, using whatever server *that* client is pointed at.
 * The URI scheme has no field for a server address, so there is no way to
 * carry ours in the link. A client that has never been told about this server
 * asks rustdesk.com's public rendezvous instead, is told the ID does not
 * exist, and reports "the target device is offline or does not exist" — about
 * an endpoint that is online and reachable.
 *
 * The fix has to happen once, on the technician's machine, before the first
 * Connect. That is what `setup.cmd` is for.
 */
@Controller('downloads')
export class DownloadsController {
  constructor(private readonly rustdesk: RustdeskService) {}

  private async requireConfig(): Promise<RustdeskServerConfig> {
    const config = await this.rustdesk.serverConfig();
    if (!config) {
      throw new ServiceUnavailableException(
        'No RustDesk relay host is configured. A Platform Admin must set it under Settings before clients can be prepared.',
      );
    }
    return config;
  }

  /** What this server can hand out, and which one a technician actually wants. */
  @Get()
  async manifest() {
    const config = await this.rustdesk.serverConfig();
    const version = await latestRustdeskVersionOr();
    return {
      success: true,
      data: {
        configured: !!config,
        relayHost: config?.host ?? null,
        rustdeskVersion: version,
        downloads: [
          {
            id: 'setup',
            label: 'Set up this computer for Connect',
            filename: 'rem0te-setup-rustdesk.cmd',
            path: '/api/v1/downloads/rustdesk/setup.cmd',
            description:
              'Points this machine\'s RustDesk at this server, fetching a portable copy first if there is none. Installs nothing. Use it to prepare a computer in advance — clicking Connect does the same work plus the connection.',
            recommended: true,
          },
          {
            id: 'configured',
            label: 'RustDesk client, preconfigured',
            filename: `rustdesk-host=${config?.host ?? ''},key=${config?.key ?? ''}.exe`,
            path: '/api/v1/downloads/rustdesk/configured',
            description:
              'A full RustDesk client that points itself at this server on first run — the config travels in the filename, so do not rename it. Use on a machine with no RustDesk yet.',
            recommended: false,
          },
          {
            id: 'plain',
            label: 'RustDesk client, unconfigured',
            filename: `rustdesk-${version}-x86_64.exe`,
            path: '/api/v1/downloads/rustdesk/plain',
            description:
              'Stock RustDesk, exactly as published upstream, pointed at nothing. It will not reach this server until you configure it — run the setup file above afterwards.',
            recommended: false,
          },
        ],
      },
    };
  }

  /** Stock RustDesk, unmodified and unconfigured. */
  @Get('rustdesk/plain')
  async plain(@Res() res: Response) {
    const version = await latestRustdeskVersionOr();
    const exePath = await this.rustdesk.cachedWindowsClient(version);
    this.sendExe(res, exePath, `rustdesk-${version}-x86_64.exe`);
  }

  /**
   * The same binary, renamed. RustDesk reads its server settings out of its own
   * filename, so this configures itself on first run — and loses that the
   * moment a browser renames it to `rustdesk (1).exe`, which is why `setup.cmd`
   * exists as the reliable path.
   */
  @Get('rustdesk/configured')
  async configured(@Res() res: Response) {
    const config = await this.requireConfig();
    const version = await latestRustdeskVersionOr();
    const exePath = await this.rustdesk.cachedWindowsClient(version);
    this.sendExe(res, exePath, `rustdesk-host=${config.host},key=${config.key}.exe`);
  }

  /**
   * Point an existing RustDesk install at this server.
   *
   * A `.cmd` rather than a `.ps1` on purpose: PowerShell scripts do not run on
   * double-click under the default execution policy, and a technician who has
   * just been told their remote support is broken should not also have to be
   * told about `Set-ExecutionPolicy`.
   */
  @Get('rustdesk/setup.cmd')
  async setupCmd(@Res() res: Response) {
    const config = await this.requireConfig();
    const script = this.rustdesk.buildSetupCmd(config, await latestRustdeskVersionOr(), this.clientDownloadUrl());
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="rem0te-setup-rustdesk.cmd"');
    res.setHeader('Cache-Control', 'no-store');
    res.send(script);
  }

  private sendExe(res: Response, exePath: string, filename: string) {
    const stat = fs.statSync(exePath);
    res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(exePath).pipe(res);
  }

  private clientDownloadUrl(): string {
    return `${(process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '')}/api/v1/public/quick-connect/download/windows`;
  }
}
