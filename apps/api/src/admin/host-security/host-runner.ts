import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import { validAddress, validJail } from './parsers';

/**
 * Everything Security → Server security does to this host, in one closed list (0.74,
 * §84). Nothing else in the security module spawns a process, and nothing
 * here builds a command from a string: each command is a fixed argument
 * array, and the few that take a value (a jail, an address, a unit) check it
 * against the same shape the root-owned wrapper does before it is passed.
 *
 * The privileged ones go through `sudo -n` and only name what the installer's
 * sudoers grants (deploy/scripts/install.sh): the rem0te-f2b wrapper, the
 * fail2ban install and enable/start, and the apt-get update / upgrade pair.
 * `-n` makes a missing grant fail at once instead of waiting on a password
 * prompt nobody can answer.
 *
 * Tests: with NODE_ENV=test and SECURITY_HOST_FIXTURE naming a JSON file, every
 * command, file, certificate and header probe is answered from the fixture
 * and nothing touches the host. Under NODE_ENV=test with no fixture, the
 * host-changing commands refuse (`changes: false`), so a scratch API on a
 * developer's machine can never ban, upgrade or install anything.
 */

export const F2B_WRAPPER = '/usr/local/sbin/rem0te-f2b';
const APT_GET = '/usr/bin/apt-get';
const SYSTEMCTL = '/usr/bin/systemctl';

/** Units whose state the page reads. */
export const UNITS = ['fail2ban', 'caddy', 'ufw', 'nftables', 'unattended-upgrades', 'ssh'] as const;
export type Unit = (typeof UNITS)[number];

/** Files the page reads (read-only). Paths are fixed; nothing a request names is opened. */
export const FILES = {
  sshd: '/etc/ssh/sshd_config',
  ufw: '/etc/ufw/ufw.conf',
  autoUpgrades: '/etc/apt/apt.conf.d/20auto-upgrades',
  rebootRequired: '/var/run/reboot-required',
  rebootPkgs: '/var/run/reboot-required.pkgs',
  aptUpdateStamp: '/var/lib/apt/periodic/update-success-stamp',
  caddyfile: '/etc/caddy/Caddyfile',
  portRange: '/proc/sys/net/ipv4/ip_local_port_range',
} as const;
export type FileId = keyof typeof FILES;

/** The only directory an sshd `Include` may expand into. */
const SSHD_INCLUDE_DIR = '/etc/ssh/sshd_config.d';

export type F2bArgs =
  | ['status'] | ['status', string]
  | ['get', string, 'ignoreip' | 'bantime' | 'findtime' | 'maxretry']
  | ['set', string, 'banip' | 'unbanip' | 'addignoreip' | 'delignoreip', string]
  | ['set', string, 'bantime' | 'findtime' | 'maxretry', string];

/** The read-only commands. */
export type ReadCommand =
  | { id: 'unit.active'; unit: Unit }
  | { id: 'f2b'; args: F2bArgs }
  | { id: 'apt.upgradable' }
  | { id: 'ss.listening' }
  | { id: 'npm.audit' };

/** The host-changing commands. Each one is step-up gated and audited by its caller. */
export type ChangeCommand =
  | { id: 'f2b.change'; args: F2bArgs }
  | { id: 'f2b.install' } | { id: 'f2b.enable' } | { id: 'f2b.start' }
  | { id: 'apt.update' } | { id: 'apt.upgrade' };

export interface RunResult { stdout: string; stderr: string; status: number; refused?: string }

const F2B_READ_GETS = new Set(['ignoreip', 'bantime', 'findtime', 'maxretry']);
const F2B_ADDR_SETS = new Set(['banip', 'unbanip', 'addignoreip', 'delignoreip']);
const F2B_NUM_SETS = new Set(['bantime', 'findtime', 'maxretry']);

/** The same shapes rem0te-f2b accepts, checked before sudo is asked. */
export function f2bArgsOk(a: readonly string[], change: boolean): boolean {
  if (!change) {
    if (a.length === 1) return a[0] === 'status';
    if (a.length === 2) return a[0] === 'status' && validJail(a[1]);
    if (a.length === 3) return a[0] === 'get' && validJail(a[1]) && F2B_READ_GETS.has(a[2]);
    return false;
  }
  if (a.length !== 4 || a[0] !== 'set' || !validJail(a[1])) return false;
  if (F2B_ADDR_SETS.has(a[2])) return validAddress(a[3]);
  if (F2B_NUM_SETS.has(a[2])) return /^[0-9]{1,9}$/.test(a[3]);
  return false;
}

/** The argv for a command, or null when its arguments are not one of the closed shapes. */
export function argvFor(c: ReadCommand | ChangeCommand, npmCache: string): string[] | null {
  switch (c.id) {
    case 'unit.active': return (UNITS as readonly string[]).includes(c.unit) ? [SYSTEMCTL, 'is-active', c.unit] : null;
    case 'f2b': return f2bArgsOk(c.args, false) ? ['sudo', '-n', F2B_WRAPPER, ...c.args] : null;
    case 'f2b.change': return f2bArgsOk(c.args, true) ? ['sudo', '-n', F2B_WRAPPER, ...c.args] : null;
    case 'apt.upgradable': return ['apt', 'list', '--upgradable'];
    // -p names the owner only of this user's own sockets; it never needs root.
    case 'ss.listening': return ['ss', '-Htlnup'];
    case 'npm.audit': return ['npm', 'audit', '--omit=dev', '--json', '--cache', npmCache];
    case 'f2b.install': return ['sudo', '-n', APT_GET, 'install', '-y', 'fail2ban'];
    case 'f2b.enable': return ['sudo', '-n', SYSTEMCTL, 'enable', 'fail2ban'];
    case 'f2b.start': return ['sudo', '-n', SYSTEMCTL, 'start', 'fail2ban'];
    case 'apt.update': return ['sudo', '-n', APT_GET, 'update'];
    case 'apt.upgrade': return ['sudo', '-n', APT_GET, 'upgrade', '-y', '--allow-downgrades', '-o', 'Dpkg::Options::=--force-confold'];
  }
}

export const CHANGE_IDS: ReadonlySet<string> = new Set(['f2b.change', 'f2b.install', 'f2b.enable', 'f2b.start', 'apt.update', 'apt.upgrade']);

export interface PeerCert { validTo: string | null; issuer: string | null; authorized: boolean; nameMatches: boolean; error?: string }
export interface HeaderProbe { status: number; headers: Record<string, string>; location?: string | null; error?: string }

interface Fixture {
  commands?: Record<string, RunResult>;
  files?: Record<string, string | null>;
  mtimes?: Record<string, string>;
  dirs?: Record<string, string[]>;
  certs?: Record<string, PeerCert>;
  https?: HeaderProbe;
  http?: HeaderProbe;
  apiDir?: string | null;
}

const key = (argv: string[]) => argv.join(' ');

@Injectable()
export class HostRunner {
  private readonly logger = new Logger(HostRunner.name);
  private fixture: Fixture | null = null;
  /** In fixture mode, the host-changing commands that would have run (argv joined), in order. */
  readonly fixtureChanges: string[] = [];

  constructor() {
    const f = process.env.SECURITY_HOST_FIXTURE;
    if (process.env.NODE_ENV === 'test' && f) {
      try { this.fixture = JSON.parse(fs.readFileSync(f, 'utf8')) as Fixture; }
      catch (e) { this.logger.error(`SECURITY_HOST_FIXTURE unreadable: ${(e as Error).message}`); this.fixture = {}; }
    }
  }

  /** True in a test process: host changes go to the fixture, or nowhere. */
  get isTest(): boolean { return process.env.NODE_ENV === 'test'; }
  get fixtureMode(): boolean { return this.fixture !== null; }

  private npmCache(): string { return path.join(os.tmpdir(), 'rem0te-npm-audit-cache'); }

  /**
   * The directory of the running API's package.json and package-lock.json:
   * two levels up from dist/admin/host-security. In production that is
   * /opt/reboot-remote/api (the generated manifest, `pnpm deploy:manifest`);
   * in a pnpm checkout there is no package-lock.json and npm audit cannot run.
   */
  apiDir(): string | null {
    if (this.fixture) return this.fixture.apiDir ?? null;
    const d = path.resolve(__dirname, '..', '..', '..');
    return fs.existsSync(path.join(d, 'package-lock.json')) ? d : null;
  }

  run(c: ReadCommand, timeoutMs = 10_000): Promise<RunResult> { return this.exec(c, timeoutMs); }

  change(c: ChangeCommand, timeoutMs = 30_000, onLine?: (line: string) => void): Promise<RunResult> {
    if (this.isTest && !this.fixture) return Promise.resolve({ stdout: '', stderr: '', status: -1, refused: 'HOST_CHANGES_OFF_IN_TEST' });
    return this.exec(c, timeoutMs, onLine);
  }

  private exec(c: ReadCommand | ChangeCommand, timeoutMs: number, onLine?: (line: string) => void): Promise<RunResult> {
    const argv = argvFor(c, this.npmCache());
    if (!argv) return Promise.resolve({ stdout: '', stderr: 'refused: arguments outside the closed list', status: -1, refused: 'BAD_ARGUMENTS' });
    if (this.fixture) {
      if (CHANGE_IDS.has(c.id)) this.fixtureChanges.push(key(argv));
      const r = this.fixture.commands?.[key(argv)] ?? this.fixture.commands?.[`${c.id}:*`];
      const out = r ?? { stdout: '', stderr: 'no fixture for this command', status: CHANGE_IDS.has(c.id) ? 0 : 127 };
      if (onLine) for (const l of `${out.stdout}\n${out.stderr}`.split('\n')) if (l.trim()) onLine(l);
      return Promise.resolve(out);
    }
    const cwd = c.id === 'npm.audit' ? this.apiDir() ?? undefined : undefined;
    return new Promise((resolve) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(argv[0], argv.slice(1), {
          cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
          env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: os.tmpdir(), DEBIAN_FRONTEND: 'noninteractive' },
        });
      } catch (e) { resolve({ stdout: '', stderr: (e as Error).message, status: -1 }); return; }
      let stdout = '', stderr = '', done = false, partial = '';
      const cap = (s: string, d: Buffer) => (s.length < 4_000_000 ? s + d.toString() : s);
      proc.stdout?.on('data', (d: Buffer) => {
        stdout = cap(stdout, d);
        if (onLine) { partial += d.toString(); const ls = partial.split('\n'); partial = ls.pop() ?? ''; ls.filter((l) => l.trim()).forEach(onLine); }
      });
      proc.stderr?.on('data', (d: Buffer) => { stderr = cap(stderr, d); if (onLine) d.toString().split('\n').filter((l) => l.trim()).forEach(onLine); });
      const finish = (status: number) => { if (done) return; done = true; clearTimeout(t); if (onLine && partial.trim()) onLine(partial); resolve({ stdout, stderr, status }); };
      const t = setTimeout(() => { proc.kill('SIGTERM'); finish(-1); }, timeoutMs);
      proc.on('close', (code) => finish(code ?? -1));
      proc.on('error', (e) => { stderr += e.message; finish(-1); });
    });
  }

  /** One of FILES, or null when it is missing or this user cannot read it. */
  readFile(id: FileId): string | null {
    const p = FILES[id];
    if (this.fixture) return this.fixture.files?.[p] ?? null;
    try { return fs.readFileSync(p, 'utf8').slice(0, 1_000_000); } catch { return null; }
  }
  exists(id: FileId): boolean {
    const p = FILES[id];
    if (this.fixture) return this.fixture.files ? p in this.fixture.files : false;
    return fs.existsSync(p);
  }
  mtime(id: FileId): Date | null {
    const p = FILES[id];
    if (this.fixture) { const v = this.fixture.mtimes?.[p]; return v ? new Date(v) : null; }
    try { return fs.statSync(p).mtime; } catch { return null; }
  }
  wrapperInstalled(): boolean {
    if (this.fixture) return !!this.fixture.files && F2B_WRAPPER in this.fixture.files;
    return fs.existsSync(F2B_WRAPPER);
  }

  /**
   * The files an sshd `Include` pattern names. Only patterns inside
   * /etc/ssh/sshd_config.d are expanded, and only a trailing `*.conf`-style
   * glob; anything else is reported as one unreadable entry so the parser
   * marks what follows as uncertain rather than guessing.
   */
  sshdInclude(pattern: string): Array<{ path: string; text: string | null }> {
    const abs = path.posix.isAbsolute(pattern) ? pattern : path.posix.join('/etc/ssh', pattern);
    const dir = path.posix.dirname(abs);
    const base = path.posix.basename(abs);
    if (dir !== SSHD_INCLUDE_DIR || !/^[A-Za-z0-9_.*-]+$/.test(base)) return [{ path: abs, text: null }];
    const re = new RegExp(`^${base.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    let names: string[];
    if (this.fixture) names = this.fixture.dirs?.[dir] ?? [];
    else { try { names = fs.readdirSync(dir); } catch { return [{ path: abs, text: null }]; } }
    return names.filter((n) => re.test(n)).sort().map((n) => {
      const p = path.posix.join(dir, n);
      if (this.fixture) return { path: p, text: this.fixture.files?.[p] ?? null };
      try { return { path: p, text: fs.readFileSync(p, 'utf8').slice(0, 200_000) }; } catch { return { path: p, text: null }; }
    });
  }

  /**
   * The certificate Caddy serves for `domain`, read over loopback with SNI:
   * the service user cannot read Caddy's certificate store, and loopback
   * avoids depending on hairpin NAT. Nothing is sent but the TLS handshake.
   */
  peerCert(domain: string): Promise<PeerCert> {
    if (this.fixture) return Promise.resolve(this.fixture.certs?.[domain] ?? { validTo: null, issuer: null, authorized: false, nameMatches: false, error: 'no fixture' });
    return new Promise((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port: 443, servername: domain, rejectUnauthorized: false, timeout: 5000 }, () => {
        const c = s.getPeerCertificate();
        const nameMatches = !!c && Object.keys(c).length > 0 && tls.checkServerIdentity(domain, c) === undefined;
        const issuer = c?.issuer ? [c.issuer.O, c.issuer.CN].filter(Boolean).join(' ') || null : null;
        resolve({ validTo: c?.valid_to ?? null, issuer, authorized: s.authorized, nameMatches, ...(s.authorized ? {} : { error: String(s.authorizationError ?? '') }) });
        s.end();
      });
      s.on('timeout', () => { s.destroy(); resolve({ validTo: null, issuer: null, authorized: false, nameMatches: false, error: 'timed out' }); });
      s.on('error', (e) => resolve({ validTo: null, issuer: null, authorized: false, nameMatches: false, error: e.message }));
    });
  }

  /**
   * The console's response headers as browsers get them: a GET of /login
   * over loopback port 443 with the public host as SNI and Host, and a GET
   * of / on port 80 to see the redirect. Bodies are discarded.
   */
  probeHeaders(host: string, scheme: 'https' | 'http'): Promise<HeaderProbe> {
    if (this.fixture) return Promise.resolve((scheme === 'https' ? this.fixture.https : this.fixture.http) ?? { status: 0, headers: {}, error: 'no fixture' });
    return new Promise((resolve) => {
      const opts = { host: '127.0.0.1', port: scheme === 'https' ? 443 : 80, path: scheme === 'https' ? '/login' : '/', method: 'GET', headers: { host, 'user-agent': 'rem0te-security-check' }, timeout: 5000 };
      const done = (res: http.IncomingMessage) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
        res.resume();
        resolve({ status: res.statusCode ?? 0, headers, location: headers.location ?? null });
      };
      const req = scheme === 'https'
        ? https.request({ ...opts, servername: host, rejectUnauthorized: false }, done)
        : http.request(opts, done);
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, headers: {}, error: 'timed out' }); });
      req.on('error', (e) => resolve({ status: 0, headers: {}, error: e.message }));
      req.end();
    });
  }
}
