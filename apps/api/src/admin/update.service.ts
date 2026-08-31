import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { Subject } from 'rxjs';
import { latestRustdeskVersion } from '../common/rustdesk-release';

interface RustdeskServerAsset { name: string; url: string; sha256: string }
interface RustdeskServerRelease { version: string; assets: RustdeskServerAsset[] }

export interface UpdateProgress {
  step: string;
  message: string;
  percent: number;
  done?: boolean;
  error?: string;
}

@Injectable()
export class UpdateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private readonly logger = new Logger(UpdateService.name);
  private readonly repoOwner = 'agit8or1';
  private readonly repoName = 'rem0te';
  private readonly versionFile = process.env.VERSION_FILE ?? path.join(process.cwd(), '..', '..', 'version.json');
  private readonly projectRoot = process.env.PROJECT_ROOT ?? path.join(process.cwd(), '..', '..');

  /**
   * Git checkout the updater builds from.
   *
   * This is NOT the same directory as PROJECT_ROOT. PROJECT_ROOT is the deploy
   * target (`/opt/reboot-remote`) — build output, version.json, uploads — and
   * it is deliberately not a git repository. The updater used to run its
   * `git fetch` there and fail on the very first step with a bare
   * "not a git repository", which read like a bug in Rem0te rather than a
   * missing configuration.
   *
   * Set SOURCE_DIR to a checkout of the repo for in-app updates to be possible
   * at all. Unset, the updater reports precisely that instead of failing
   * halfway through.
   */
  private readonly sourceDir = process.env.SOURCE_DIR ?? null;

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
    // Readiness is folded into the response below by the controller.
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
    // Two simple passes rather than one nested-quantifier regex: match the
    // heading line, then pull the date out of the remainder. Keeps both
    // patterns at star height 1, so there is no backtracking to reason about.
    //
    // Horizontal whitespace only — `\s` matches newlines, and under /m that let
    // the date group reach onto the following line.
    const heading = /^##[ \t]*\[(\d+\.\d+\.\d+)\][ \t]*([^\n]*)$/gm;
    const dateInHeading = /(\d{4}-\d{2}-\d{2})/;

    const matches = [...raw.matchAll(heading)];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const bodyStart = m.index! + m[0].length;
      const bodyEnd = i + 1 < matches.length ? matches[i + 1].index! : raw.length;
      const notes = raw
        .slice(bodyStart, bodyEnd)
        .replace(/\n---\s*$/, '')
        .trim();

      // m[2] is the rest of the heading line ("— 2026-08-25 · *Ledger*");
      // pull the date out of it in a second, trivially-bounded pass.
      const date = dateInHeading.exec(m[2] ?? '')?.[1];

      out.push({
        version: m[1],
        notes,
        publishedAt: date ? new Date(`${date}T00:00:00Z`).toISOString() : '',
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

  /**
   * Whether an in-app update could actually run, and if not, exactly why.
   *
   * Reported by GET /admin/update/check so the UI can disable the button with
   * a reason rather than offering an action that dies on its first command.
   */
  updaterReadiness(): { ready: boolean; reason: string | null } {
    if (!this.isUpdateEnabled()) {
      return {
        ready: false,
        reason:
          'In-app updates are disabled. Updates are supply-chain critical and are meant to be ' +
          'applied by an operator who can verify the release signature. Set ALLOW_IN_APP_UPDATE=true ' +
          'to opt in.',
      };
    }
    if (!this.sourceDir) {
      return {
        ready: false,
        reason:
          'SOURCE_DIR is not set. The updater builds from a git checkout, which is a different ' +
          'directory from PROJECT_ROOT (the deploy target). Point SOURCE_DIR at a clone of the ' +
          'repository that the service account can read and write.',
      };
    }
    if (!fs.existsSync(path.join(this.sourceDir, '.git'))) {
      return {
        ready: false,
        reason: `SOURCE_DIR (${this.sourceDir}) is not a git checkout, so there is nothing to fetch a release into.`,
      };
    }
    return { ready: true, reason: null };
  }

  /**
   * Validates a version string before it reaches `git fetch` / `git checkout`.
   * The value comes from a GitHub tag name, so it is remote input on a
   * supply-chain-critical path.
   *
   * Every quantifier is bounded, so the total work is bounded and there is no
   * catastrophic backtracking to exploit — but keep the bounds if you edit it.
   */
  private isValidVersion(v: string): boolean {
    // Hard length cap before the pattern sees anything. Every quantifier below
    // is already bounded, so the work was bounded regardless, but capping the
    // input makes that true by inspection rather than by analysis — worth it
    // on a path that feeds `git fetch` / `git checkout`.
    if (typeof v !== 'string' || v.length > 64) return false;

    // All quantifiers below are bounded ({1,5} / {1,32}) and the input is
    // capped above, so there is no unbounded backtracking to exploit. Keep the
    // bounds if you edit this.
    // eslint-disable-next-line security/detect-unsafe-regex
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
        const readiness = this.updaterReadiness();
        if (!readiness.ready) {
          fail('unavailable', readiness.reason!);
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
        await this.runProc('pnpm', ['--filter', '@reboot-remote/api', 'build'], emit, 'build-api', 57, 72);

        emit('build-web', 'Building web app…', 74);
        await this.runProc('pnpm', ['--filter', '@reboot-remote/web', 'build'], emit, 'build-web', 74, 88);

        emit('deploy', 'Deploying web assets…', 90);

        // Server code is replaced wholesale…
        await this.runProc('rsync', [
          '-a', '--delete',
          '--exclude', 'apps/web/.next/static/',
          'apps/web/.next/standalone/',
          '/opt/reboot-remote/web/standalone/',
        ], emit, 'deploy', 90, 92);

        // …but the hashed client chunks are ADDED, never deleted.
        //
        // Next.js requests chunks by content hash. A browser that already has
        // the app open is still asking for the previous build's filenames, and
        // deleting them mid-session 404s the running client — which surfaces
        // as the page reloading itself, or bouncing back to /login. New builds
        // get new hashes, so old files simply go unreferenced; prune them on a
        // maintenance window, not during a deploy.
        await this.runProc('rsync', [
          '-a',
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
      // Build steps run in the checkout; only the rsync/cp targets below point
      // at the deploy directory, and those are absolute paths.
      const proc = spawn(cmd, args, { cwd: this.sourceDir ?? this.projectRoot, shell: false });
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

  // ── RustDesk server (hbbs / hbbr) ─────────────────────────────────────────
  //
  // Distinct from both updates above: this is the rendezvous and relay pair
  // this platform runs, not Rem0te and not the client on an endpoint. It had
  // no update path at all — install.sh installed it once and every later run
  // reported "already installed" — so a deployment could sit on a version for
  // as long as nobody thought to check by hand. That is not hypothetical: the
  // /ws/id and /ws/relay routes shipped in 0.8.2 were dead on arrival because
  // 1.1.15 accepts the WebSocket upgrade and immediately drops it, and nothing
  // surfaced that the server was two releases behind.

  /** Where the .deb pair is staged. Fixed, because the sudoers rule names it. */
  private readonly rustdeskServerStaging = '/var/lib/reboot-remote/rustdesk-server';

  private rustdeskServerCache: { release: RustdeskServerRelease; fetchedAt: number } | null = null;

  /**
   * Latest rustdesk-server release, with the SHA-256 GitHub publishes for each
   * asset. Null if GitHub has not been reachable.
   *
   * The digests are the point. These packages are installed with `dpkg -i` as
   * root, and until now nothing checked that the bytes on disk were the bytes
   * the release names — a hostile redirect, a CDN edge or a compromised
   * upstream account would have owned the host. GitHub returns
   * `digest: "sha256:…"` per asset; a release that does not carry one is not
   * installed.
   */
  private async rustdeskServerRelease(): Promise<RustdeskServerRelease | null> {
    if (this.rustdeskServerCache && Date.now() - this.rustdeskServerCache.fetchedAt < 3600_000) {
      return this.rustdeskServerCache.release;
    }
    const stale = () => this.rustdeskServerCache?.release ?? null;
    return new Promise((resolve) => {
      const req = https.get(
        'https://api.github.com/repos/rustdesk/rustdesk-server/releases/latest',
        { headers: { 'User-Agent': 'reboot-remote', Accept: 'application/vnd.github.v3+json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              const json = JSON.parse(data) as {
                tag_name?: string;
                assets?: { name?: string; browser_download_url?: string; digest?: string }[];
              };
              const version = String(json.tag_name ?? '').replace(/^v/, '');
              if (!/^\d+\.\d+\.\d+$/.test(version)) return resolve(stale());
              const assets: RustdeskServerAsset[] = [];
              for (const a of json.assets ?? []) {
                const sha = /^sha256:([0-9a-f]{64})$/.exec(a.digest ?? '')?.[1];
                // Only https URLs on github.com: the download follows redirects,
                // and the starting point should not be attacker-chosen either.
                if (!a.name || !a.browser_download_url || !sha) continue;
                if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(a.browser_download_url)) continue;
                assets.push({ name: a.name, url: a.browser_download_url, sha256: sha });
              }
              const release = { version, assets };
              this.rustdeskServerCache = { release, fetchedAt: Date.now() };
              resolve(release);
            } catch {
              resolve(stale());
            }
          });
        },
      );
      req.on('error', () => resolve(stale()));
      req.setTimeout(8000, () => { req.destroy(); resolve(stale()); });
    });
  }

  /** Latest rustdesk-server version. Null if GitHub has not been reachable. */
  private async latestRustdeskServerVersion(): Promise<string | null> {
    return (await this.rustdeskServerRelease())?.version ?? null;
  }

  /** SHA-256 of a file on disk, as lowercase hex. */
  private sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(file);
      stream.on('data', (c) => hash.update(c));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }

  /** `hbbs --version` → "1.1.16". Null when the binary is missing or mute. */
  private installedRustdeskServerVersion(binary: 'hbbs' | 'hbbr'): Promise<string | null> {
    return new Promise((resolve) => {
      const proc = spawn(`/usr/bin/${binary}`, ['--version'], { shell: false });
      let out = '';
      proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
      proc.on('error', () => resolve(null));
      proc.on('close', () => {
        const m = out.match(/(\d+\.\d+\.\d+)/);
        resolve(m ? m[1] : null);
      });
    });
  }

  async rustdeskServerStatus() {
    const [latest, hbbs, hbbr] = await Promise.all([
      this.latestRustdeskServerVersion(),
      this.installedRustdeskServerVersion('hbbs'),
      this.installedRustdeskServerVersion('hbbr'),
    ]);

    return {
      latestVersion: latest,
      hbbs,
      hbbr,
      // Both binaries ship from the same release and are meant to match. They
      // can diverge if one .deb failed to install, which is worth showing
      // rather than averaging away.
      mismatched: !!hbbs && !!hbbr && hbbs !== hbbr,
      // Unknown rather than "outdated" when GitHub is unreachable or the
      // binaries are missing — the same rule the client table follows.
      upToDate: latest && hbbs && hbbr
        ? this.compareVersions(hbbs, latest) >= 0 && this.compareVersions(hbbr, latest) >= 0
        : null,
      // WebSocket rendezvous over 443 needs 1.1.16; 1.1.15 accepts the upgrade
      // then drops the connection, with no error on either side.
      websocketCapable: hbbs ? this.compareVersions(hbbs, '1.1.16') >= 0 : null,
    };
  }

  /**
   * Download and install the latest rustdesk-server .deb pair, then restart
   * both units.
   *
   * The restart is the part worth warning about: hbbs holds its online-peer
   * map in memory only, so every endpoint reads as offline until it
   * re-registers — about 30 seconds — and a Connect attempted inside that
   * window fails with "the target device is offline or does not exist".
   */
  async updateRustdeskServer(actor: { userId?: string; ip?: string }) {
    const release = await this.rustdeskServerRelease();
    if (!release) {
      throw new NotFoundException('The latest rustdesk-server version is unavailable right now');
    }
    const latest = release.version;

    const status = await this.rustdeskServerStatus();
    if (status.upToDate && !status.mismatched) {
      return { updated: false, version: latest, message: `Already on ${latest}.` };
    }

    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    fs.mkdirSync(this.rustdeskServerStaging, { recursive: true });

    const debs = (['hbbs', 'hbbr'] as const).map((which) => {
      const assetName = `rustdesk-server-${which}_${latest}_${arch}.deb`;
      const asset = release.assets.find((a) => a.name === assetName);
      if (!asset) {
        throw new NotFoundException(
          `Release ${latest} does not publish ${assetName} with a checksum. Refusing to install it.`,
        );
      }
      return { name: `${which}.deb`, asset };
    });

    // Download, then verify against the digest GitHub published for that asset
    // before anything is handed to dpkg. A file that does not match is deleted
    // rather than left in the staging directory the sudoers rule points at.
    for (const deb of debs) {
      const target = path.join(this.rustdeskServerStaging, deb.name);
      await this.downloadTo(deb.asset.url, target);
      const actual = await this.sha256File(target);
      if (actual !== deb.asset.sha256) {
        fs.unlinkSync(target);
        await this.audit.log({
          actorId: actor.userId, actorIp: actor.ip,
          action: 'SETTINGS_UPDATED', resource: 'rustdesk_server', resourceId: deb.name,
          meta: { refused: 'checksum_mismatch', expected: deb.asset.sha256, actual, version: latest },
        });
        throw new NotFoundException(
          `${deb.asset.name} did not match the checksum GitHub published for it. Nothing was installed.`,
        );
      }
    }

    const noop = () => { /* no progress stream on this path */ };
    // Fixed argument list, matching the sudoers rule exactly. dpkg is given
    // both packages in one call because hbbs and hbbr must not be left on
    // different versions if the second install fails.
    await this.runProc('sudo', [
      '-n', '/usr/bin/dpkg', '-i',
      path.join(this.rustdeskServerStaging, 'hbbs.deb'),
      path.join(this.rustdeskServerStaging, 'hbbr.deb'),
    ], noop, 'install', 0, 0);

    await this.runProc('sudo', [
      '-n', '/usr/bin/systemctl', 'restart', 'rustdesk-hbbs', 'rustdesk-hbbr',
    ], noop, 'restart', 0, 0);

    await this.audit.log({
      actorId: actor.userId, actorIp: actor.ip,
      action: 'SETTINGS_UPDATED', resource: 'rustdesk_server', resourceId: 'hbbs+hbbr',
      meta: { from: `${status.hbbs ?? 'unknown'}/${status.hbbr ?? 'unknown'}`, to: latest },
    });

    return {
      updated: true,
      version: latest,
      message: `rustdesk-server updated to ${latest}. Endpoints re-register within about 30 seconds.`,
    };
  }

  /** Straight HTTPS download to a path, following GitHub's release redirects. */
  private downloadTo(url: string, target: string): Promise<void> {
    const tmp = `${target}.part`;
    return new Promise<void>((resolve, reject) => {
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
            return reject(new Error(`Download failed with HTTP ${r.statusCode} for ${u}`));
          }
          r.pipe(out);
          out.on('finish', () => out.close(() => resolve()));
        }).on('error', reject);
      };
      get(url);
    })
      .then(() => { fs.renameSync(tmp, target); })
      .catch((err) => {
        try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
        throw err;
      });
  }

  // ── RustDesk client updates on managed endpoints ──────────────────────────
  //
  // Separate from the Rem0te self-update above: this tracks the RustDesk
  // version installed on each endpoint and stages upgrades for them. The
  // endpoint reports `version` on every heartbeat; staging writes a target and
  // the endpoint's next heartbeat response tells it to re-run the installer.

  /** Per-endpoint RustDesk versions plus the latest available release. */
  async rustdeskStatus() {
    const [latest, nodes] = await Promise.all([
      latestRustdeskVersion(),
      this.prisma.rustdeskNode.findMany({
        select: {
          rustdeskId: true, version: true, lastSeenAt: true,
          updateRequestedAt: true, updateTargetVersion: true,
          endpoint: { select: { id: true, name: true, hostname: true, isOnline: true, platform: true } },
        },
        orderBy: { hostname: 'asc' },
      }),
    ]);

    const endpoints = nodes.map((n) => ({
      endpointId: n.endpoint?.id ?? null,
      name: n.endpoint?.name ?? n.rustdeskId,
      hostname: n.endpoint?.hostname ?? null,
      platform: n.endpoint?.platform ?? null,
      isOnline: n.endpoint?.isOnline ?? false,
      rustdeskId: n.rustdeskId,
      version: n.version ?? null,
      lastSeenAt: n.lastSeenAt,
      updatePending: !!n.updateRequestedAt,
      updateTargetVersion: n.updateTargetVersion,
      // Unknown until the endpoint heartbeats with a version, which only
      // installers from v0.8.2 onward report. Explicitly not "outdated":
      // flagging every pre-upgrade endpoint as out of date would be noise.
      upToDate: latest && n.version ? this.compareVersions(n.version, latest) >= 0 : null,
    }));

    return {
      latestVersion: latest,
      total: endpoints.length,
      outdated: endpoints.filter((e) => e.upToDate === false).length,
      unknown: endpoints.filter((e) => e.upToDate === null).length,
      endpoints,
    };
  }

  /**
   * Stage a RustDesk upgrade. Returns how many endpoints were queued.
   * Endpoints already on the target are skipped rather than pointlessly
   * re-running an installer on them.
   */
  async requestRustdeskUpdate(
    endpointIds: string[] | null,
    actor: { userId?: string; ip?: string },
  ) {
    const latest = await latestRustdeskVersion();
    if (!latest) throw new NotFoundException('Latest RustDesk version is unavailable right now');

    const nodes = await this.prisma.rustdeskNode.findMany({
      where: endpointIds?.length ? { endpointId: { in: endpointIds } } : {},
      select: { id: true, endpointId: true, version: true, tenantId: true },
    });
    if (!nodes.length) throw new NotFoundException('No matching endpoints');

    const targets = nodes.filter(
      (n) => !n.version || this.compareVersions(n.version, latest) < 0,
    );

    await this.prisma.rustdeskNode.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { updateRequestedAt: new Date(), updateTargetVersion: latest },
    });

    for (const t of targets) {
      await this.audit.log({
        tenantId: t.tenantId ?? undefined,
        actorId: actor.userId, actorIp: actor.ip,
        action: 'ENDPOINT_UPDATED', resource: 'endpoint', resourceId: t.endpointId,
        meta: { rustdeskFrom: t.version ?? 'unknown', rustdeskTo: latest },
      });
    }

    return { requested: targets.length, skipped: nodes.length - targets.length, targetVersion: latest };
  }

  /** Cancel a staged update. */
  async cancelRustdeskUpdate(endpointId: string) {
    const r = await this.prisma.rustdeskNode.updateMany({
      where: { endpointId },
      data: { updateRequestedAt: null, updateTargetVersion: null },
    });
    return { cancelled: r.count };
  }

  /** Numeric-segment compare; tolerates junk by treating it as 0. */
  private compareVersions(a: string, b: string): number {
    const pa = a.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = b.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d < 0 ? -1 : 1;
    }
    return 0;
  }
}
