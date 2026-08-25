import { Injectable, Logger } from '@nestjs/common';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
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
  private readonly versionFile = process.env.VERSION_FILE ?? path.join(process.cwd(), '..', '..', 'version.json');
  private readonly projectRoot = process.env.PROJECT_ROOT ?? path.join(process.cwd(), '..', '..');

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

  /**
   * Release history.
   *
   * The shipped CHANGELOG.md is the authority — it is complete, it travels with
   * the release, and it works with no network. GitHub Releases are only used to
   * enrich entries with a real publish date, and only when reachable.
   *
   * Reading it from GitHub alone used to drop versions on the floor two ways:
   * the query was capped at 10 releases, and several versions were never cut as
   * GitHub Releases at all even though they shipped.
   */
  async getChangelog(): Promise<{ version: string; notes: string; publishedAt: string }[]> {
    const local = this.parseChangelogFile();
    const dates = await this.fetchReleaseDates();

    if (local.length === 0) {
      // No CHANGELOG on disk (unusual) — fall back to whatever GitHub has.
      return Object.entries(dates).map(([version, meta]) => ({
        version, notes: meta.notes, publishedAt: meta.publishedAt,
      }));
    }

    return local.map((e) => ({
      ...e,
      publishedAt: dates[e.version]?.publishedAt ?? e.publishedAt,
    }));
  }

  /**
   * Parse `## [1.2.3] — 2026-08-25 · *Codename*` sections out of CHANGELOG.md.
   * Everything up to the next `## [` heading is that version's notes.
   */
  private parseChangelogFile(): { version: string; notes: string; publishedAt: string }[] {
    const candidates = [
      path.join(this.projectRoot, 'CHANGELOG.md'),
      path.join(process.cwd(), '..', '..', 'CHANGELOG.md'),
      path.join(process.cwd(), 'CHANGELOG.md'),
    ];

    let raw = '';
    for (const file of candidates) {
      try {
        raw = fs.readFileSync(file, 'utf8');
        break;
      } catch { /* try the next location */ }
    }
    if (!raw) return [];

    const out: { version: string; notes: string; publishedAt: string }[] = [];
    const heading = /^##\s*\[(\d+\.\d+\.\d+)\]\s*(?:[—\-–]\s*(\d{4}-\d{2}-\d{2}))?/gm;

    const matches = [...raw.matchAll(heading)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const bodyStart = m.index! + m[0].length;
      const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : raw.length;
      const notes = raw
        .slice(bodyStart, bodyEnd)
        .replace(/\n---\s*$/, '')
        .trim();

      out.push({
        version: m[1],
        notes,
        publishedAt: m[2] ? new Date(`${m[2]}T00:00:00Z`).toISOString() : '',
      });
    }
    return out;
  }

  /** Best-effort publish dates from GitHub. Never blocks the response. */
  private async fetchReleaseDates(): Promise<Record<string, { publishedAt: string; notes: string }>> {
    return new Promise((resolve) => {
      const req = https.get(
        `https://api.github.com/repos/${this.repoOwner}/${this.repoName}/releases?per_page=100`,
        { headers: { 'User-Agent': 'rem0te-updater', Accept: 'application/vnd.github.v3+json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const releases = JSON.parse(data) as Array<Record<string, unknown>>;
              const map: Record<string, { publishedAt: string; notes: string }> = {};
              for (const r of releases) {
                const version = ((r.tag_name as string) ?? '').replace(/^v/, '');
                if (!version) continue;
                map[version] = {
                  publishedAt: (r.published_at as string) ?? '',
                  notes: (r.body as string) ?? '',
                };
              }
              resolve(map);
            } catch {
              resolve({});
            }
          });
        },
      );
      req.on('error', () => resolve({}));
      req.setTimeout(8000, () => { req.destroy(); resolve({}); });
    });
  }

  private isUpdateEnabled(): boolean {
    return process.env.ALLOW_IN_APP_UPDATE === 'true';
  }

  private isValidVersion(v: string): boolean {
    return /^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(?:[-.+][A-Za-z0-9._-]{1,32})?$/.test(v);
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
        if (!this.isUpdateEnabled()) {
          fail('disabled',
            'In-app updates are disabled on this server. ' +
            'Updates are a supply-chain-critical operation and must be performed by an operator ' +
            'who can verify the release signature. Set ALLOW_IN_APP_UPDATE=true only if you accept ' +
            'that this server will git-checkout and build code fetched from GitHub without additional ' +
            'signature verification.');
          return;
        }

        emit('check', 'Checking for update…', 5);
        const info = await this.checkForUpdate();
        if (!info.hasUpdate) {
          emit('check', `Already on latest version (${info.currentVersion})`, 100, { done: true });
          subject.complete();
          this.activeUpdate = null;
          return;
        }

        // Validate the version string BEFORE it reaches any shell — otherwise a hostile
        // GitHub response could inject arbitrary characters into `git fetch/checkout`.
        if (!this.isValidVersion(info.latestVersion)) {
          fail('validate', `Refusing to apply update — release tag '${info.latestVersion}' is not a valid semver`);
          return;
        }
        // Reject downgrades even if the version parser is confused
        if (!this.isNewer(info.latestVersion, info.currentVersion)) {
          fail('validate', `Refusing to apply update — refusing downgrade from ${info.currentVersion} to ${info.latestVersion}`);
          return;
        }

        const tag = `v${info.latestVersion}`;

        emit('fetch', `Fetching tag ${tag} from GitHub…`, 10);
        await this.runProc('git', ['fetch', 'origin', `tag`, tag, '--no-tags'], emit, 'fetch', 15, 20);

        // Verify the tag is signed and the signature is trusted. If gpg is not
        // installed or the tag is unsigned, refuse — better to fail than blindly
        // build attacker-controlled code with elevated privileges.
        emit('verify', `Verifying tag signature…`, 22);
        try {
          await this.runProc('git', ['tag', '--verify', tag], emit, 'verify', 22, 24);
        } catch {
          fail('verify',
            `Refusing to apply update — tag ${tag} is unsigned or the signature is not trusted. ` +
            `Either sign releases with git tag -s and add the maintainer key to the server's GPG keyring, ` +
            `or update the server manually.`);
          return;
        }

        emit('checkout', `Checking out ${tag}…`, 25);
        await this.runProc('git', ['checkout', tag], emit, 'checkout', 25, 40);

        emit('deps', 'Installing dependencies…', 42);
        await this.runProc('pnpm', ['install', '--frozen-lockfile'], emit, 'deps', 42, 55);

        emit('build-api', 'Building API…', 57);
        await this.runProc('pnpm', ['--filter', 'api', 'build'], emit, 'build-api', 57, 72);

        emit('build-web', 'Building web app…', 74);
        await this.runProc('pnpm', ['--filter', 'web', 'build'], emit, 'build-web', 74, 88);

        emit('deploy', 'Deploying web assets…', 90);
        await this.runProc('rsync', [
          '-a', '--delete',
          'apps/web/.next/standalone/',
          '/opt/reboot-remote/web/standalone/',
        ], emit, 'deploy', 90, 92);
        await this.runProc('rsync', [
          '-a', '--delete',
          'apps/web/.next/static/',
          '/opt/reboot-remote/web/standalone/apps/web/.next/static/',
        ], emit, 'deploy', 92, 94);

        // version.json drives the version banner and the update check;
        // CHANGELOG.md is what Release History is parsed from. Without these
        // the UI keeps reporting the previous release after a successful update.
        await this.runProc('cp', ['version.json', '/opt/reboot-remote/version.json'],
          emit, 'deploy', 94, 94);
        await this.runProc('cp', ['CHANGELOG.md', '/opt/reboot-remote/CHANGELOG.md'],
          emit, 'deploy', 94, 95);

        emit('restart', 'Restarting services…', 95);
        await this.runProc('sudo', [
          '-n',
          'systemctl', 'restart', 'reboot-remote-api', 'reboot-remote-web',
        ], emit, 'restart', 95, 99);

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

  private runProc(
    cmd: string,
    args: string[],
    emit: (step: string, msg: string, pct: number) => void,
    step: string,
    startPct: number,
    endPct: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // shell:false — arguments never touch a shell interpreter so no globbing,
      // no interpolation, no command chaining.
      const proc = spawn(cmd, args, { cwd: this.projectRoot, shell: false });
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
        else reject(new Error(`Command failed (exit ${code}): ${cmd} ${args.join(' ')}`));
      });
      proc.on('error', (err) => reject(err));
    });
  }

  private isNewer(a: string, b: string): boolean {
    const parse = (v: string): number[] => {
      const parts = v.split(/[.+-]/).slice(0, 3).map((p) => parseInt(p, 10));
      if (parts.length < 3) parts.push(...new Array(3 - parts.length).fill(0));
      return parts;
    };
    const av = parse(a);
    const bv = parse(b);
    if (av.some((n) => !Number.isFinite(n)) || bv.some((n) => !Number.isFinite(n))) return false;
    for (let i = 0; i < 3; i++) {
      if (av[i] !== bv[i]) return av[i] > bv[i];
    }
    return false;
  }
}
