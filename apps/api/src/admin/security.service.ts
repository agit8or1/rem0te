import { Injectable } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SecurityService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Async promise cache (deduplicates concurrent requests) ───────────────
  private readonly _cache = new Map<string, { promise: Promise<unknown>; at: number }>();

  private cachedAsync<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;
    const promise = fn().catch((e) => {
      if (this._cache.get(key)?.promise === promise) this._cache.delete(key);
      throw e;
    });
    this._cache.set(key, { promise, at: Date.now() });
    return promise;
  }

  private bustCache(key: string) { this._cache.delete(key); }

  // ── Non-blocking child process helper ─────────────────────────────────────
  private runAsync(
    cmd: string,
    args: string[],
    opts: { timeout?: number; input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
  ): Promise<{ stdout: string; stderr: string; status: number }> {
    return new Promise((resolve) => {
      const proc = spawn(cmd, args, {
        stdio: opts.input !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        env: opts.env ?? process.env,
        cwd: opts.cwd,
      });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      if (opts.input !== undefined) proc.stdin?.end(opts.input);
      let done = false;
      const finish = (code: number) => { if (!done) { done = true; resolve({ stdout, stderr, status: code }); } };
      proc.on('close', finish);
      proc.on('error', () => finish(-1));
      if (opts.timeout) setTimeout(() => { if (!done) { proc.kill(); finish(-1); } }, opts.timeout);
    });
  }

  // ── Config ────────────────────────────────────────────────────────────────

  async getConfig() {
    const config = await this.prisma.platformSecurityConfig.findFirst();
    return (
      config ?? {
        id: null,
        geoipBlockEnabled: false,
        ipAllowlistEnabled: false,
        blockedCountries: [],
        blockedIpRanges: [],
        allowedIpRanges: [],
        maxLoginAttempts: 5,
        lockoutMinutes: 15,
      }
    );
  }

  async updateConfig(data: {
    geoipBlockEnabled?: boolean;
    ipAllowlistEnabled?: boolean;
    blockedCountries?: string[];
    blockedIpRanges?: string[];
    allowedIpRanges?: string[];
    maxLoginAttempts?: number;
    lockoutMinutes?: number;
  }) {
    const existing = await this.prisma.platformSecurityConfig.findFirst();
    if (existing) {
      return this.prisma.platformSecurityConfig.update({
        where: { id: existing.id },
        data,
      });
    } else {
      return this.prisma.platformSecurityConfig.create({ data });
    }
  }

  // ── fail2ban ──────────────────────────────────────────────────────────────

  getFail2ban() { return this.cachedAsync('fail2ban', 120_000, () => this._getFail2ban()); }
  private async _getFail2ban() {
    try {
      const svcCheck = await this.runAsync('systemctl', ['is-active', 'fail2ban'], { timeout: 3000 });
      const isActive = svcCheck.stdout.trim() === 'active';
      if (!isActive) return { running: false, jails: [] };

      const result = await this.runAsync('sudo', ['fail2ban-client', 'status'], { timeout: 5000 });
      const statusOut = result.stdout.trim();
      if (result.status !== 0 || !statusOut) return { running: true, jails: [] };

      const jailMatch = statusOut.match(/Jail list:\s+(.+)/);
      const jailNames = jailMatch
        ? jailMatch[1].split(',').map((j) => j.trim()).filter(Boolean)
        : [];

      const jails = await Promise.all(
        jailNames.map(async (jail) => {
          const safeJail = jail.replace(/[^a-zA-Z0-9_-]/g, '');
          const detail = await this.runAsync('sudo', ['fail2ban-client', 'status', safeJail], { timeout: 3000 });
          const out = detail.stdout;
          const totalMatch = out.match(/Total banned:\s+(\d+)/);
          const currentMatch = out.match(/Currently banned:\s+(\d+)/);
          const ipsMatch = out.match(/Banned IP list:\s*(.*)/);
          const bannedIps = ipsMatch ? ipsMatch[1].trim().split(/\s+/).filter(Boolean) : [];
          return {
            jail: safeJail,
            totalBanned: totalMatch ? parseInt(totalMatch[1], 10) : 0,
            currentBanned: currentMatch ? parseInt(currentMatch[1], 10) : 0,
            bannedIps,
          };
        }),
      );

      return { running: true, jails };
    } catch {
      return { running: false, jails: [] };
    }
  }

  bustFail2banCache() { this.bustCache('fail2ban'); }

  async banIp(jail: string, ip: string) {
    const safeJail = jail.replace(/[^a-zA-Z0-9_-]/g, '');
    const safeIp = ip.replace(/[^0-9a-fA-F.:/]/g, '');
    if (!safeJail || !safeIp) return { success: false, error: 'Invalid input' };
    const result = await this.runAsync('sudo', ['fail2ban-client', 'set', safeJail, 'banip', safeIp], { timeout: 5000 });
    const ok = result.status === 0;
    if (ok) this.bustCache('fail2ban');
    return { success: ok, error: ok ? undefined : result.stderr.trim() };
  }

  private parseIgnoreIps(output: string): string[] {
    // fail2ban-client get <jail> ignoreip outputs one of:
    //   "No IP address/network is ignored"
    //   "These IP addresses/networks are ignored:\n`- 1.2.3.4\n`- 10.0.0.0/8"
    return output
      .split('\n')
      .map(l => l.replace(/^`-\s*/, '').trim())
      .filter(l => /^[\d:a-fA-F][0-9a-fA-F.:/]*$/.test(l));
  }

  async getIgnoreList() {
    try {
      // Try each jail and merge; use 'www' (the primary jail) first
      const jailsResult = await this.runAsync('sudo', ['fail2ban-client', 'status'], { timeout: 5000 });
      const jailMatch = jailsResult.stdout.match(/Jail list:\s+(.+)/);
      const jailNames = jailMatch ? jailMatch[1].split(',').map(j => j.trim()).filter(Boolean) : ['www'];
      const results = await Promise.all(
        jailNames.map(j => this.runAsync('sudo', ['fail2ban-client', 'get', j.replace(/[^a-zA-Z0-9_-]/g, ''), 'ignoreip'], { timeout: 5000 })),
      );
      const all = new Set<string>();
      for (const r of results) this.parseIgnoreIps(r.stdout).forEach(ip => all.add(ip));
      return { ips: [...all] };
    } catch { return { ips: [] }; }
  }

  async addIgnoreIp(ip: string) {
    const safeIp = ip.replace(/[^0-9a-fA-F.:/]/g, '');
    if (!safeIp) return { success: false, error: 'Invalid IP' };
    try {
      const jailsResult = await this.runAsync('sudo', ['fail2ban-client', 'status'], { timeout: 5000 });
      const jailMatch = jailsResult.stdout.match(/Jail list:\s+(.+)/);
      const jailNames = jailMatch ? jailMatch[1].split(',').map(j => j.trim()).filter(Boolean) : [];
      const results = await Promise.all(
        jailNames.map(j => this.runAsync('sudo', ['fail2ban-client', 'set', j.replace(/[^a-zA-Z0-9_-]/g, ''), 'addignoreip', safeIp], { timeout: 5000 })),
      );
      const anyOk = results.some(r => r.status === 0);
      if (anyOk) this.bustCache('fail2ban');
      return { success: anyOk };
    } catch (e: unknown) { return { success: false, error: (e as Error).message }; }
  }

  async removeIgnoreIp(ip: string) {
    const safeIp = ip.replace(/[^0-9a-fA-F.:/]/g, '');
    if (!safeIp) return { success: false, error: 'Invalid IP' };
    try {
      const jailsResult = await this.runAsync('sudo', ['fail2ban-client', 'status'], { timeout: 5000 });
      const jailMatch = jailsResult.stdout.match(/Jail list:\s+(.+)/);
      const jailNames = jailMatch ? jailMatch[1].split(',').map(j => j.trim()).filter(Boolean) : [];
      await Promise.all(
        jailNames.map(j => this.runAsync('sudo', ['fail2ban-client', 'set', j.replace(/[^a-zA-Z0-9_-]/g, ''), 'delignoreip', safeIp], { timeout: 5000 })),
      );
      this.bustCache('fail2ban');
      return { success: true };
    } catch (e: unknown) { return { success: false, error: (e as Error).message }; }
  }

  async getJailConfig(jail: string) {
    const safeJail = jail.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeJail) return { success: false, error: 'Invalid jail name' };
    try {
      const [bt, ft, mr] = await Promise.all([
        this.runAsync('sudo', ['fail2ban-client', 'get', safeJail, 'bantime'], { timeout: 3000 }),
        this.runAsync('sudo', ['fail2ban-client', 'get', safeJail, 'findtime'], { timeout: 3000 }),
        this.runAsync('sudo', ['fail2ban-client', 'get', safeJail, 'maxretry'], { timeout: 3000 }),
      ]);
      return { success: true, config: { bantime: bt.stdout.trim(), findtime: ft.stdout.trim(), maxretry: mr.stdout.trim() } };
    } catch (e: unknown) { return { success: false, error: (e as Error).message }; }
  }

  async updateJailConfig(jail: string, bantime?: number, findtime?: number, maxretry?: number) {
    const safeJail = jail.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeJail) return { success: false, error: 'Invalid jail name' };
    try {
      const updates: Array<[string, number]> = [];
      if (bantime !== undefined) updates.push(['bantime', bantime]);
      if (findtime !== undefined) updates.push(['findtime', findtime]);
      if (maxretry !== undefined) updates.push(['maxretry', maxretry]);
      await Promise.all(
        updates.map(([key, val]) => this.runAsync('sudo', ['fail2ban-client', 'set', safeJail, key, String(val)], { timeout: 5000 })),
      );
      this.bustCache('fail2ban');
      return { success: true };
    } catch (e: unknown) { return { success: false, error: (e as Error).message }; }
  }

  async unbanIp(jail: string, ip: string) {
    const safeJail = jail.replace(/[^a-zA-Z0-9_-]/g, '');
    const safeIp = ip.replace(/[^0-9a-fA-F.:/]/g, '');
    if (!safeJail || !safeIp) return { success: false, error: 'Invalid input' };
    const result = await this.runAsync('sudo', ['fail2ban-client', 'set', safeJail, 'unbanip', safeIp], { timeout: 5000 });
    const ok = result.status === 0;
    if (ok) this.bustCache('fail2ban');
    return { success: ok };
  }

  async installFail2ban() {
    await this.runAsync('sudo', ['apt-get', 'install', '-y', 'fail2ban'], {
      timeout: 120000,
      env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
    });
    await this.runAsync('sudo', ['systemctl', 'enable', 'fail2ban'], { timeout: 10000 });
    await this.runAsync('sudo', ['systemctl', 'start', 'fail2ban'], { timeout: 10000 });
    return { success: true };
  }

  // ── npm audit fix ─────────────────────────────────────────────────────────

  async runAuditFix(force = false) {
    try {
      const deployBase = '/opt/reboot-remote';
      const sourceBase = '/home/administrator/reboot-remote';
      const cwd = fs.existsSync(`${deployBase}/api/package.json`) ? `${deployBase}/api` : `${sourceBase}/apps/api`;

      const args = force
        ? ['audit', 'fix', '--force', '--cache', '/tmp/npm-audit-cache']
        : ['audit', 'fix', '--cache', '/tmp/npm-audit-cache'];
      const result = await this.runAsync('npm', args, {
        timeout: 120000,
        cwd,
        env: { ...process.env, NODE_ENV: 'production' },
      });

      const output = result.stdout + result.stderr;
      return { success: result.status === 0, output: output.slice(-3000), force };
    } catch (e: unknown) {
      return { success: false, error: (e as Error).message, force };
    }
  }

  // ── OS Updates ────────────────────────────────────────────────────────────

  getOsUpdates() { return this.cachedAsync('os-updates', 600_000, () => this._getOsUpdates()); }
  private async _getOsUpdates() {
    try {
      const r = await this.runAsync('apt', ['list', '--upgradable'], { timeout: 15000 });
      const out = r.stdout;

      const lines = out
        .split('\n')
        .filter((l) => l.includes('/') && !l.startsWith('Listing'));

      const packages = lines.map((line) => {
        const parts = line.split(/\s+/);
        return {
          name: parts[0]?.split('/')[0] ?? line,
          version: parts[1] ?? '',
          security: line.toLowerCase().includes('security'),
        };
      });

      const securityUpdates = packages.filter((p) => p.security).length;
      return { total: packages.length, packages, securityUpdates };
    } catch {
      return { total: 0, packages: [], securityUpdates: 0 };
    }
  }

  private updateJob: { running: boolean; lines: string[]; exitCode: number | null; startedAt: string } | null = null;

  runOsUpdate() {
    if (this.updateJob?.running) {
      return { success: false, error: 'Update already in progress' };
    }
    this.updateJob = { running: true, lines: [], exitCode: null, startedAt: new Date().toISOString() };

    const proc = spawn('sudo', [
      'apt-get', 'upgrade', '-y', '--allow-downgrades',
      '-o', 'Dpkg::Options::=--force-confold',
    ], { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });

    const pushLines = (chunk: Buffer) => {
      const newLines = chunk.toString().split('\n').filter(l => l.trim());
      this.updateJob!.lines.push(...newLines);
      if (this.updateJob!.lines.length > 1000) this.updateJob!.lines.splice(0, 200);
    };
    proc.stdout.on('data', pushLines);
    proc.stderr.on('data', pushLines);
    proc.on('close', (code) => {
      if (this.updateJob) { this.updateJob.running = false; this.updateJob.exitCode = code; }
      this.bustCache('os-updates');
    });
    proc.on('error', (e) => {
      if (this.updateJob) { this.updateJob.running = false; this.updateJob.exitCode = -1; this.updateJob.lines.push(`Error: ${e.message}`); }
    });

    return { success: true, running: true };
  }

  getOsUpdateStatus() {
    if (!this.updateJob) return { running: false, lines: [], exitCode: null, startedAt: null };
    return {
      running: this.updateJob.running,
      lines: this.updateJob.lines,
      exitCode: this.updateJob.exitCode,
      startedAt: this.updateJob.startedAt,
    };
  }

  // ── Code Audit ────────────────────────────────────────────────────────────

  runAudit() { return this.cachedAsync('audit', 900_000, () => this._runAudit()); }
  private async _runAudit() {
    // Paths that work in both dev (/home/administrator/reboot-remote/apps/api) and
    // production (/opt/reboot-remote/api) — use WorkingDirectory as the npm audit cwd.
    const deployBase = '/opt/reboot-remote';
    const sourceBase = '/home/administrator/reboot-remote';
    // npm audit: run in whichever location has a package-lock.json
    const cwd = fs.existsSync(`${deployBase}/api/package.json`) ? `${deployBase}/api` : `${sourceBase}/apps/api`;
    // Source dirs to scan — scan both if they exist
    const srcDirs = [
      `${deployBase}/api/dist`,
      `${sourceBase}/apps/api/src`,
      `${sourceBase}/apps/web/app`,
    ].filter((d) => fs.existsSync(d));
    // ESLint binary — prefer system-wide, fall back to nvm
    const eslintBin = (await this.runAsync('which', ['eslint'], { timeout: 3000 })).stdout.trim() || '/usr/bin/eslint';
    const sysNodeMods = '/usr/lib/node_modules';
    const eslintConfig = '/opt/reboot-remote/eslint-security.config.mjs';
    // Semgrep rules — fixed deployed location
    const semgrepRules = '/opt/reboot-remote/semgrep-rules/nodejs-security.yml';

    // Write eslint config (always regenerate so it stays in sync)
    try {
      fs.writeFileSync(eslintConfig, `
import security from "${sysNodeMods}/eslint-plugin-security/index.js";
import tsParser from "${sysNodeMods}/@typescript-eslint/parser/dist/index.js";
export default [
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsParser },
    plugins: { security },
    rules: {
      "security/detect-object-injection": "warn",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-unsafe-regex": "error",
      "security/detect-buffer-noassert": "error",
      "security/detect-child-process": "warn",
      "security/detect-eval-with-expression": "error",
      "security/detect-new-buffer": "warn",
      "security/detect-non-literal-fs-filename": "warn",
      "security/detect-non-literal-require": "warn",
      "security/detect-possible-timing-attacks": "warn",
      "security/detect-pseudoRandomBytes": "error",
    }
  },
  { files: ["**/*.js"], plugins: { security }, rules: { "security/detect-child-process": "warn", "security/detect-eval-with-expression": "error" } }
];`.trim());
    } catch { /* ignore */ }

    // ── 1. npm audit ─────────────────────────────────────────────────────────
    let packages: unknown[] = [];
    let outdated: string[] = [];
    let npmMeta: unknown = null;
    try {
      const auditResult = await this.runAsync('npm', ['audit', '--json', '--cache', '/tmp/npm-audit-cache'], { timeout: 60000, cwd });
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(auditResult.stdout ?? '{}'); } catch { /* ignore */ }
      npmMeta = (parsed.metadata as unknown) ?? null;
      const vulns = (parsed.vulnerabilities as Record<string, unknown>) ?? {};
      packages = Object.entries(vulns).map(([label, vuln]) => {
        const v = vuln as Record<string, unknown>;
        const via = Array.isArray(v.via) ? v.via : [];
        const vulnerabilities = via
          .filter((x) => typeof x === 'object' && x !== null)
          .map((x: Record<string, unknown>) => ({ severity: (x.severity as string) ?? 'unknown', title: (x.title as string) ?? undefined }));
        return { label, total: vulnerabilities.length || 1, summary: (v.severity as string) ?? '', vulnerabilities };
      });
    } catch { /* ignore */ }

    try {
      const outdatedResult = await this.runAsync('npm', ['outdated', '--json', '--cache', '/tmp/npm-audit-cache'], { timeout: 30000, cwd });
      // npm outdated exits 1 when packages are outdated — use stdout regardless of exit code
      const outdatedJson = outdatedResult.stdout?.trim();
      if (outdatedJson && outdatedJson.startsWith('{')) outdated = Object.keys(JSON.parse(outdatedJson));
    } catch { /* ignore */ }

    // ── 2. ESLint security plugin ─────────────────────────────────────────────
    interface EslintIssue { ruleId: string; severity: number; message: string; line: number; column: number; }
    interface EslintFile { filePath: string; messages: EslintIssue[]; }
    let eslintIssues: Array<{ file: string; line: number; rule: string; severity: string; message: string }> = [];
    let eslintError: string | null = null;
    try {
      if (fs.existsSync(eslintBin) && srcDirs.length > 0) {
        const result = await this.runAsync(eslintBin, ['--config', eslintConfig, '--format', 'json', ...srcDirs], { timeout: 60000 });
        const raw = result.stdout + result.stderr;
        const jsonStart = raw.indexOf('[');
        if (jsonStart !== -1) {
          const files: EslintFile[] = JSON.parse(raw.slice(jsonStart));
          eslintIssues = files.flatMap((f) =>
            f.messages.map((m) => ({
              file: f.filePath.replace(sourceBase + '/', '').replace(deployBase + '/', ''),
              line: m.line,
              rule: m.ruleId ?? 'unknown',
              severity: m.severity === 2 ? 'error' : 'warning',
              message: m.message,
            })),
          );
        }
      } else if (!fs.existsSync(eslintBin)) {
        eslintError = 'eslint not found — run: sudo npm install -g eslint eslint-plugin-security @typescript-eslint/parser';
      }
    } catch (e: unknown) {
      eslintError = (e as Error).message;
    }

    // ── 3. Semgrep ────────────────────────────────────────────────────────────
    interface SemgrepResult { check_id: string; path: string; start: { line: number }; extra: { message: string; severity: string } }
    let semgrepIssues: Array<{ file: string; line: number; rule: string; severity: string; message: string }> = [];
    let semgrepError: string | null = null;
    try {
      const semgrepBin = (await this.runAsync('which', ['semgrep'], { timeout: 3000 })).stdout.trim();
      if (semgrepBin && fs.existsSync(semgrepRules) && srcDirs.length > 0) {
        const result = await this.runAsync(semgrepBin, ['scan', '--config', semgrepRules, ...srcDirs, '--json'], { timeout: 120000 });
        const raw = result.stdout;
        const jsonStart = raw.indexOf('{');
        if (jsonStart !== -1) {
          const parsed = JSON.parse(raw.slice(jsonStart));
          semgrepIssues = ((parsed.results as SemgrepResult[]) ?? []).map((r) => ({
            file: r.path.replace(sourceBase + '/', '').replace(deployBase + '/', ''),
            line: r.start.line,
            rule: r.check_id.split('.').pop() ?? r.check_id,
            severity: (r.extra.severity ?? 'WARNING').toLowerCase(),
            message: r.extra.message,
          }));
        }
      } else if (!semgrepBin) {
        semgrepError = 'semgrep not found — run: sudo snap install semgrep';
      } else if (!fs.existsSync(semgrepRules)) {
        semgrepError = `Rules not found at ${semgrepRules}`;
      }
    } catch (e: unknown) {
      semgrepError = (e as Error).message;
    }

    return {
      scannedAt: new Date().toISOString(),
      packages,
      outdated,
      metadata: npmMeta,
      eslint: { issues: eslintIssues, error: eslintError },
      semgrep: { issues: semgrepIssues, error: semgrepError },
    };
  }

  // ── TLS renewal ───────────────────────────────────────────────────────────

  async renewTls(): Promise<{ success: boolean; message: string }> {
    // Use the Caddy admin API (localhost:2019) to reload config without spawning
    // a subprocess — spawning caddy reload kills the proxy connection → 502.
    return new Promise((resolve) => {
      // Step 1: GET current config
      const getReq = http.get('http://localhost:2019/config/', (getRes) => {
        let body = '';
        getRes.on('data', (chunk) => (body += chunk));
        getRes.on('end', () => {
          let configJson: string;
          try {
            JSON.parse(body); // validate it's parseable
            configJson = body;
          } catch {
            resolve({ success: false, message: 'Failed to read Caddy config: invalid JSON' });
            return;
          }

          // Step 2: POST config back to /load — triggers cert provisioning
          const postOpts = {
            hostname: 'localhost',
            port: 2019,
            path: '/load',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(configJson),
            },
          };
          const postReq = http.request(postOpts, (postRes) => {
            let postBody = '';
            postRes.on('data', (c) => (postBody += c));
            postRes.on('end', () => {
              if (postRes.statusCode === 200) {
                this.bustCache('tls');
                resolve({ success: true, message: 'Certificate renewal requested. Caddy is reloading.' });
              } else {
                resolve({ success: false, message: `Caddy reload failed (HTTP ${postRes.statusCode}): ${postBody}` });
              }
            });
          });
          postReq.on('error', (e) => resolve({ success: false, message: `Caddy admin POST error: ${e.message}` }));
          postReq.setTimeout(10000, () => { postReq.destroy(); resolve({ success: false, message: 'Caddy admin POST timed out' }); });
          postReq.write(configJson);
          postReq.end();
        });
      });
      getReq.on('error', (e) => resolve({ success: false, message: `Caddy admin GET error: ${e.message}` }));
      getReq.setTimeout(5000, () => { getReq.destroy(); resolve({ success: false, message: 'Caddy admin GET timed out' }); });
    });
  }

  // ── TLS ───────────────────────────────────────────────────────────────────

  getTls() { return this.cachedAsync('tls', 120_000, () => this._getTls()); }
  bustTlsCache() { this.bustCache('tls'); }
  private async _getTls() {
    const svcCheck = await this.runAsync('systemctl', ['is-active', 'caddy'], { timeout: 3000 });
    const caddyActive = svcCheck.stdout.trim() === 'active';

    const certs: Array<{ domain: string; expiresAt: string; daysLeft: number }> = [];
    const caddyCertDirs = [
      '/var/lib/caddy/.local/share/caddy/certificates',
      '/root/.local/share/caddy/certificates',
      '/home/caddy/.local/share/caddy/certificates',
    ];

    for (const certDir of caddyCertDirs) {
      if (!fs.existsSync(certDir)) continue;
      try {
        const providers = fs.readdirSync(certDir);
        for (const provider of providers) {
          const provPath = path.join(certDir, provider);
          if (!fs.statSync(provPath).isDirectory()) continue;
          const domains = fs.readdirSync(provPath);
          for (const domain of domains) {
            const certFile = path.join(provPath, domain, `${domain}.crt`);
            if (!fs.existsSync(certFile)) continue;
            try {
              const certPem = fs.readFileSync(certFile, 'utf8');
              const result = await this.runAsync('openssl', ['x509', '-noout', '-enddate'], { input: certPem, timeout: 3000 });
              const match = result.stdout.trim().match(/notAfter=(.+)/);
              if (match) {
                const expiresAt = new Date(match[1]);
                const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / 86400000);
                certs.push({ domain, expiresAt: expiresAt.toISOString(), daysLeft });
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
      if (certs.length > 0) break;
    }

    // Fallback: filesystem access denied — read cert directly from live HTTPS using openssl s_client
    if (certs.length === 0 && caddyActive) {
      const domains = this.getDomainsFromCaddyfile();
      for (const domain of domains) {
        try {
          const sClient = await this.runAsync(
            'sh',
            ['-c', 'echo | openssl s_client -connect "$1:443" -servername "$1" 2>/dev/null', '--', domain],
            { timeout: 8000 },
          );
          if (!sClient.stdout.includes('BEGIN CERTIFICATE')) continue;
          const x509 = await this.runAsync('openssl', ['x509', '-noout', '-enddate'], { input: sClient.stdout, timeout: 3000 });
          const match = x509.stdout.match(/notAfter=(.+)/);
          if (match) {
            const expiresAt = new Date(match[1]);
            const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / 86400000);
            certs.push({ domain, expiresAt: expiresAt.toISOString(), daysLeft });
          }
        } catch { /* ignore */ }
      }
    }

    return { caddyActive, hasTls: caddyActive && certs.length > 0, certs };
  }

  private getDomainsFromCaddyfile(): string[] {
    try {
      const content = fs.readFileSync('/etc/caddy/Caddyfile', 'utf8');
      // Match bare domain names at start of server blocks (not http:// lines)
      const matches = [...content.matchAll(/^([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*\{/gm)];
      return matches.map(m => m[1]);
    } catch { return []; }
  }
}
