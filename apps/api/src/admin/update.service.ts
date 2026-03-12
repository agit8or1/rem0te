import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import { Subject } from 'rxjs';

export interface UpdateProgress {
  step: string;
  message: string;
  percent: number;
  done?: boolean;
  error?: string;
}

@Injectable()
export class UpdateService {
  private readonly logger = new Logger(UpdateService.name);
  private readonly repoOwner = 'agit8or1';
  private readonly repoName = 'rem0te';
  private readonly versionFile = path.join(process.cwd(), '..', '..', 'version.json');
  private readonly projectRoot = path.join(process.cwd(), '..', '..');

  private activeUpdate: Subject<UpdateProgress> | null = null;

  getCurrentVersion(): string {
    try {
      const v = JSON.parse(fs.readFileSync(this.versionFile, 'utf8'));
      return v.version ?? '0.1.0';
    } catch {
      return '0.1.0';
    }
  }

  async checkForUpdate(): Promise<{
    currentVersion: string;
    latestVersion: string;
    hasUpdate: boolean;
    releaseUrl: string | null;
    releaseNotes: string | null;
    publishedAt: string | null;
  }> {
    const current = this.getCurrentVersion();
    return new Promise((resolve) => {
      const req = https.get(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases/latest`,
        { headers: { 'User-Agent': 'rem0te-updater', Accept: 'application/vnd.github.v3+json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              const latest: string = (json.tag_name ?? '').replace(/^v/, '');
              resolve({
                currentVersion: current,
                latestVersion: latest || current,
                hasUpdate: latest ? this.isNewer(latest, current) : false,
                releaseUrl: json.html_url ?? null,
                releaseNotes: json.body ?? null,
                publishedAt: json.published_at ?? null,
              });
            } catch {
              resolve({ currentVersion: current, latestVersion: current, hasUpdate: false, releaseUrl: null, releaseNotes: null, publishedAt: null });
            }
          });
        },
      );
      req.on('error', () => resolve({ currentVersion: current, latestVersion: current, hasUpdate: false, releaseUrl: null, releaseNotes: null, publishedAt: null }));
      req.setTimeout(8000, () => { req.destroy(); resolve({ currentVersion: current, latestVersion: current, hasUpdate: false, releaseUrl: null, releaseNotes: null, publishedAt: null }); });
    });
  }

  async getChangelog(): Promise<{ version: string; notes: string; publishedAt: string }[]> {
    return new Promise((resolve) => {
      const req = https.get(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases?per_page=10`,
        { headers: { 'User-Agent': 'rem0te-updater', Accept: 'application/vnd.github.v3+json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const releases = JSON.parse(data) as Array<Record<string, unknown>>;
              resolve(releases.map((r) => ({
                version: ((r.tag_name as string) ?? '').replace(/^v/, ''),
                notes: (r.body as string) ?? '',
                publishedAt: (r.published_at as string) ?? '',
              })));
            } catch {
              resolve([]);
            }
          });
        },
      );
      req.on('error', () => resolve([]));
      req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    });
  }

  applyUpdate(): Subject<UpdateProgress> {
    if (this.activeUpdate) return this.activeUpdate;

    const subject = new Subject<UpdateProgress>();
    this.activeUpdate = subject;

    const emit = (step: string, message: string, percent: number, extras?: Partial<UpdateProgress>) => {
      subject.next({ step, message, percent, ...extras });
    };

    const fail = (step: string, error: string) => {
      subject.next({ step, message: error, percent: 0, error, done: true });
      subject.complete();
      this.activeUpdate = null;
    };

    (async () => {
      try {
        emit('check', 'Checking for update…', 5);
        const info = await this.checkForUpdate();
        if (!info.hasUpdate) {
          emit('check', `Already on latest version (${info.currentVersion})`, 100, { done: true });
          subject.complete();
          this.activeUpdate = null;
          return;
        }

        emit('fetch', `Fetching v${info.latestVersion} from GitHub…`, 10);
        await this.runShell('git fetch origin main', emit, 'fetch', 15, 20);

        emit('pull', 'Pulling latest code…', 25);
        await this.runShell('git pull origin main', emit, 'pull', 25, 40);

        emit('deps', 'Installing dependencies…', 42);
        await this.runShell('pnpm install --frozen-lockfile', emit, 'deps', 42, 55);

        emit('build-api', 'Building API…', 57);
        await this.runShell('pnpm --filter api build', emit, 'build-api', 57, 72);

        emit('build-web', 'Building web app…', 74);
        await this.runShell('pnpm --filter web build', emit, 'build-web', 74, 88);

        emit('deploy', 'Deploying web assets…', 90);
        await this.runShell(
          'rsync -a --delete apps/web/.next/standalone/ /opt/reboot-remote/web/standalone/ && rsync -a --delete apps/web/.next/static/ /opt/reboot-remote/web/standalone/apps/web/.next/static/',
          emit, 'deploy', 90, 94,
        );

        emit('restart', 'Restarting services…', 95);
        await this.runShell('sudo systemctl restart reboot-remote-api reboot-remote-web', emit, 'restart', 95, 99);

        // Update version.json
        try {
          const vJson = JSON.parse(fs.readFileSync(this.versionFile, 'utf8'));
          vJson.version = info.latestVersion;
          vJson.releaseDate = new Date().toISOString().split('T')[0];
          fs.writeFileSync(this.versionFile, JSON.stringify(vJson, null, 2) + '\n');
        } catch { /* ignore */ }

        emit('done', `Successfully updated to v${info.latestVersion}!`, 100, { done: true });
        subject.complete();
        this.activeUpdate = null;
      } catch (e: unknown) {
        fail('error', (e as Error).message ?? 'Update failed');
      }
    })();

    return subject;
  }

  private runShell(
    cmd: string,
    emit: (step: string, msg: string, pct: number) => void,
    step: string,
    startPct: number,
    endPct: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('bash', ['-c', cmd], { cwd: this.projectRoot });
      const lines: string[] = [];
      let pct = startPct;
      const range = endPct - startPct;

      proc.stdout.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          lines.push(line);
          pct = Math.min(endPct, startPct + (lines.length / Math.max(lines.length + 5, 10)) * range);
          emit(step, line.slice(0, 120), Math.round(pct));
        }
      });
      proc.stderr.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) emit(step, line.slice(0, 120), Math.round(pct));
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Command failed (exit ${code}): ${cmd}`));
      });
    });
  }

  private isNewer(a: string, b: string): boolean {
    const parse = (v: string) => v.split('.').map(Number);
    const [am, an, ap] = parse(a);
    const [bm, bn, bp] = parse(b);
    if (am !== bm) return am > bm;
    if (an !== bn) return an > bn;
    return ap > bp;
  }
}
