import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as os from 'node:os';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditChainService } from '../audit/audit-chain.service';
import { PublicUrlService } from '../platform/public-url.service';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { SignerClient } from '../actions/signer.client';
import { msaGrantsEnabled } from '../msa/msa-grants-flag';
import type { ActorContext } from '../rbac/access-control.service';
import { HostRunner, type F2bArgs, type RunResult } from './host-security/host-runner';
import {
  certStatus, evaluateHeaders, jailWatchesOtherUnit, parseAptUpgradable, parseAutoUpgrades, parseCaddyDomains, parseF2bJail, parseF2bNumber,
  parseF2bStatus, parseIgnoreIps, parseNpmAudit, parseRebootPkgs, parseSshdConfig, parseSsListeners, parseUfwConf,
  unexpectedListeners, validAddress, validJail, type AptPackage, type HeaderCheck, type JailStatus, type Listener, type NpmAudit, type SshdConfig,
} from './host-security/parsers';
import { nodeEnvFinding, offSwitches, scoreOf, type Finding, type Severity } from './host-security/posture';

/**
 * Admin → Security (rewritten in 0.74). Platform Admin only (the controller).
 *
 * Every read of the host goes through HostRunner's closed list, and every
 * read answers with what it could not read: `state: 'unavailable'` and a
 * reason, never an empty list that the page would show as "nothing to
 * worry about". Every change is step-up gated by the controller and audited
 * here (HOST_SECURITY_CHANGED / LOGIN_POLICY_CHANGED) with its outcome.
 */

type Cached<T> = { promise: Promise<T>; at: number };
const sevOrder: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface Fail2banView {
  state: 'running' | 'stopped' | 'not_installed' | 'unavailable';
  reason: string | null;
  checkedAt: string;
  jails: Array<{ jail: string; error: string | null } & Partial<JailStatus>>;
}

export interface OsUpdatesView {
  state: 'ok' | 'unavailable';
  reason: string | null;
  checkedAt: string;
  total: number | null;
  security: number | null;
  packages: AptPackage[];
  listsUpdatedAt: string | null;
  rebootRequired: boolean;
  rebootPackages: string[];
  kernel: string;
  unattended: { configured: { updateLists: boolean; unattended: boolean } | null; serviceActive: boolean | null };
}

export interface TlsView {
  checkedAt: string;
  caddyActive: boolean | null;
  caddyfileReadable: boolean;
  certs: Array<{ domain: string; expiresAt: string | null; daysLeft: number | null; level: string; issuer: string | null; trusted: boolean; nameMatches: boolean; error: string | null }>;
}

export interface DependencyAuditView {
  state: 'ok' | 'unavailable';
  reason: string | null;
  scannedAt: string;
  scope: string;
  audit: NpmAudit | null;
}

const short = (r: RunResult) => (r.refused ? r.refused : (r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ').slice(0, 300)) || `exit ${r.status}`;

@Injectable()
export class SecurityService {
  private readonly logger = new Logger(SecurityService.name);
  private readonly cache = new Map<string, Cached<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly chain: AuditChainService,
    private readonly urls: PublicUrlService,
    private readonly updateTrust: UpdateTrustService,
    private readonly signer: SignerClient,
    readonly host: HostRunner,
  ) {}

  private cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, fresh = false): Promise<T> {
    const hit = this.cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;
    const promise = fn().catch((e) => { if (this.cache.get(key)?.promise === promise) this.cache.delete(key); throw e; });
    this.cache.set(key, { promise, at: Date.now() });
    return promise;
  }
  private bust(...keys: string[]) { for (const k of keys) this.cache.delete(k); }

  private async record(actor: ActorContext, action: 'HOST_SECURITY_CHANGED' | 'LOGIN_POLICY_CHANGED', meta: Record<string, unknown>) {
    await this.audit.log({ actorId: actor.userId, actorIp: actor.ip, action, resource: 'server_security', resourceId: 'host', meta });
  }

  // ── Sign-in lockout (enforced) and the stored rules nothing enforces ──────

  async getConfig() {
    const c = await this.prisma.platformSecurityConfig.findFirst();
    return {
      maxLoginAttempts: c?.maxLoginAttempts ?? 5,
      lockoutMinutes: c?.lockoutMinutes ?? 15,
      // Stored since before 0.18 and never enforced by anything (see
      // docs/server-security.md). Reported so the page can say so, and cleared
      // by `clearUnenforced`; there is no way to set them.
      unenforced: {
        geoipBlockEnabled: c?.geoipBlockEnabled ?? false,
        ipAllowlistEnabled: c?.ipAllowlistEnabled ?? false,
        blockedCountries: c?.blockedCountries ?? [],
        blockedIpRanges: c?.blockedIpRanges ?? [],
        allowedIpRanges: c?.allowedIpRanges ?? [],
      },
    };
  }

  /** Would this change weaken the lockout? Then it asks (login.lockout); tightening never does. */
  static weakens(before: { maxLoginAttempts: number; lockoutMinutes: number }, next: { maxLoginAttempts?: number; lockoutMinutes?: number }): boolean {
    const max = next.maxLoginAttempts ?? before.maxLoginAttempts;
    const min = next.lockoutMinutes ?? before.lockoutMinutes;
    if (max === 0 && before.maxLoginAttempts !== 0) return true;
    if (before.maxLoginAttempts !== 0 && max > before.maxLoginAttempts) return true;
    return min < before.lockoutMinutes;
  }

  async updateConfig(actor: ActorContext, next: { maxLoginAttempts?: number; lockoutMinutes?: number; clearUnenforced?: boolean }, confirm: (weakens: boolean) => void) {
    const existing = await this.prisma.platformSecurityConfig.findFirst();
    const before = { maxLoginAttempts: existing?.maxLoginAttempts ?? 5, lockoutMinutes: existing?.lockoutMinutes ?? 15 };
    confirm(SecurityService.weakens(before, next));
    const data = {
      ...(next.maxLoginAttempts !== undefined ? { maxLoginAttempts: next.maxLoginAttempts } : {}),
      ...(next.lockoutMinutes !== undefined ? { lockoutMinutes: next.lockoutMinutes } : {}),
      ...(next.clearUnenforced ? { geoipBlockEnabled: false, ipAllowlistEnabled: false, blockedCountries: [], blockedIpRanges: [], allowedIpRanges: [] } : {}),
    };
    if (existing) await this.prisma.platformSecurityConfig.update({ where: { id: existing.id }, data });
    else await this.prisma.platformSecurityConfig.create({ data });
    const after = await this.getConfig();
    if (after.maxLoginAttempts !== before.maxLoginAttempts || after.lockoutMinutes !== before.lockoutMinutes || next.clearUnenforced) {
      await this.record(actor, 'LOGIN_POLICY_CHANGED', {
        before, after: { maxLoginAttempts: after.maxLoginAttempts, lockoutMinutes: after.lockoutMinutes },
        ...(next.clearUnenforced ? { clearedUnenforced: true } : {}),
      });
    }
    this.bust('posture');
    return after;
  }

  // ── fail2ban ──────────────────────────────────────────────────────────────

  getFail2ban(fresh = false) { return this.cached('fail2ban', 30_000, () => this.readFail2ban(), fresh); }

  private async readFail2ban(): Promise<Fail2banView> {
    const checkedAt = new Date().toISOString();
    const unit = (await this.host.run({ id: 'unit.active', unit: 'fail2ban' })).stdout.trim();
    if (!this.host.wrapperInstalled()) {
      return { state: 'unavailable', checkedAt, jails: [], reason: `The rem0te-f2b wrapper is not installed in /usr/local/sbin (fail2ban service: ${unit || 'unknown'}). Re-run the installer's sudoers step (deploy/scripts/install.sh).` };
    }
    if (!unit) return { state: 'unavailable', checkedAt, jails: [], reason: 'systemctl gave no answer for fail2ban.' };
    if (unit !== 'active') {
      // The wrapper execs /usr/bin/fail2ban-client: a missing binary is "not installed", anything else is stopped.
      const status = await this.host.run({ id: 'f2b', args: ['status'] });
      const notInstalled = /No such file or directory|not found/.test(status.stderr);
      return { state: notInstalled ? 'not_installed' : 'stopped', checkedAt, jails: [], reason: `systemctl is-active fail2ban: ${unit}` };
    }
    const status = await this.host.run({ id: 'f2b', args: ['status'] });
    const names = status.status === 0 ? parseF2bStatus(status.stdout) : null;
    if (!names) return { state: 'unavailable', checkedAt, jails: [], reason: `fail2ban is running but its status could not be read: ${short(status)}` };
    const jails = await Promise.all(names.map(async (jail) => {
      const r = await this.host.run({ id: 'f2b', args: ['status', jail] });
      const s = r.status === 0 ? parseF2bJail(r.stdout) : null;
      return s ? { jail, error: null, ...s } : { jail, error: `Could not read this jail: ${short(r)}` };
    }));
    return { state: 'running', reason: null, checkedAt, jails };
  }

  private async jailNames(): Promise<string[]> {
    const r = await this.host.run({ id: 'f2b', args: ['status'] });
    const names = r.status === 0 ? parseF2bStatus(r.stdout) : null;
    if (!names) throw new ServiceUnavailableException({ code: 'FAIL2BAN_UNAVAILABLE', message: `fail2ban's jail list could not be read: ${short(r)}` });
    return names;
  }

  async getIgnoreList() {
    const checkedAt = new Date().toISOString();
    const names = await this.jailNames();
    const per = await Promise.all(names.map(async (jail) => {
      const r = await this.host.run({ id: 'f2b', args: ['get', jail, 'ignoreip'] });
      return { jail, ok: r.status === 0, ips: r.status === 0 ? parseIgnoreIps(r.stdout) : [] };
    }));
    const all = [...new Set(per.flatMap((p) => p.ips))];
    return { checkedAt, ips: all, perJail: per.map((p) => ({ jail: p.jail, ok: p.ok, ips: p.ips })), unreadable: per.filter((p) => !p.ok).map((p) => p.jail) };
  }

  private async f2bChange(actor: ActorContext, op: string, args: F2bArgs, meta: Record<string, unknown>) {
    const r = await this.host.change({ id: 'f2b.change', args });
    const ok = r.status === 0;
    await this.record(actor, 'HOST_SECURITY_CHANGED', { op, ...meta, ok, ...(ok ? {} : { error: short(r) }) });
    this.bust('fail2ban', 'posture');
    return { ok, r };
  }

  private fail(r: RunResult, what: string): never {
    if (r.refused === 'HOST_CHANGES_OFF_IN_TEST') throw new ServiceUnavailableException({ code: 'HOST_CHANGES_OFF_IN_TEST', message: 'This is a test process: it changes nothing on the host.' });
    throw new BadGatewayException({ code: 'HOST_COMMAND_FAILED', message: `${what} failed: ${short(r)}` });
  }

  async banIp(actor: ActorContext, jail: unknown, ip: unknown) {
    if (!validJail(jail) || !validAddress(ip)) throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Name a jail and an IPv4 or IPv6 address (optionally a CIDR).' });
    if (actor.ip && actor.ip === ip) throw new ConflictException({ code: 'BAN_SELF', message: 'That is the address you are connected from. Banning it would lock you out.' });
    const { ok, r } = await this.f2bChange(actor, 'fail2ban.ban', ['set', jail, 'banip', ip], { jail, address: ip });
    if (!ok) this.fail(r, 'The ban');
    return { jail, ip, persistent: false };
  }

  async unbanIp(actor: ActorContext, jail: unknown, ip: unknown) {
    if (!validJail(jail) || !validAddress(ip)) throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Name a jail and an IPv4 or IPv6 address.' });
    const { ok, r } = await this.f2bChange(actor, 'fail2ban.unban', ['set', jail, 'unbanip', ip], { jail, address: ip });
    if (!ok) this.fail(r, 'The unban');
    return { jail, ip };
  }

  private async ignoreChange(actor: ActorContext, ip: unknown, add: boolean) {
    if (!validAddress(ip)) throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Give an IPv4 or IPv6 address, optionally a CIDR.' });
    const names = await this.jailNames();
    const results = [];
    for (const jail of names) {
      const r = await this.host.change({ id: 'f2b.change', args: ['set', jail, add ? 'addignoreip' : 'delignoreip', ip] });
      results.push({ jail, ok: r.status === 0, ...(r.status === 0 ? {} : { error: short(r) }) });
      if (r.refused === 'HOST_CHANGES_OFF_IN_TEST') this.fail(r, 'The change');
    }
    const failed = results.filter((x) => !x.ok).map((x) => x.jail);
    await this.record(actor, 'HOST_SECURITY_CHANGED', { op: add ? 'fail2ban.ignore.add' : 'fail2ban.ignore.remove', address: ip, jails: names, failed });
    this.bust('fail2ban', 'posture');
    if (failed.length) throw new BadGatewayException({ code: 'HOST_COMMAND_FAILED', message: `Not applied in ${failed.join(', ')}: ${results.find((x) => !x.ok)?.error}` });
    return { ip, jails: names, persistent: false };
  }
  addIgnoreIp(actor: ActorContext, ip: unknown) { return this.ignoreChange(actor, ip, true); }
  removeIgnoreIp(actor: ActorContext, ip: unknown) { return this.ignoreChange(actor, ip, false); }

  async getJailConfig(jail: unknown) {
    if (!validJail(jail)) throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid jail name.' });
    const keys = ['bantime', 'findtime', 'maxretry'] as const;
    const rs = await Promise.all(keys.map((k) => this.host.run({ id: 'f2b', args: ['get', jail, k] })));
    const vals = rs.map((r) => (r.status === 0 ? parseF2bNumber(r.stdout) : null));
    if (vals.some((v) => v === null)) throw new ServiceUnavailableException({ code: 'FAIL2BAN_UNAVAILABLE', message: `This jail's settings could not be read: ${short(rs[vals.findIndex((v) => v === null)])}` });
    return { jail, bantime: vals[0], findtime: vals[1], maxretry: vals[2] };
  }

  async updateJailConfig(actor: ActorContext, jail: unknown, body: { bantime?: number; findtime?: number; maxretry?: number }) {
    if (!validJail(jail)) throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Invalid jail name.' });
    const changes = (['bantime', 'findtime', 'maxretry'] as const).filter((k) => body[k] !== undefined);
    if (!changes.length) throw new BadRequestException({ code: 'NOTHING_TO_CHANGE', message: 'Nothing to change.' });
    const before = await this.getJailConfig(jail).catch(() => null);
    const applied: string[] = [];
    for (const k of changes) {
      const r = await this.host.change({ id: 'f2b.change', args: ['set', jail, k, String(body[k])] });
      if (r.status !== 0) {
        await this.record(actor, 'HOST_SECURITY_CHANGED', { op: 'fail2ban.jail.set', jail, before, requested: body, applied, ok: false, failedAt: k, error: short(r) });
        this.bust('fail2ban', 'posture');
        this.fail(r, `Setting ${k}`);
      }
      applied.push(k);
    }
    await this.record(actor, 'HOST_SECURITY_CHANGED', { op: 'fail2ban.jail.set', jail, before, requested: body, applied, ok: true });
    this.bust('fail2ban', 'posture');
    return { ...(await this.getJailConfig(jail)), persistent: false };
  }

  /**
   * Install, enable and start fail2ban, through the three commands sudoers
   * grants. Each step's exit status is checked; before 0.74 this answered
   * success whatever apt-get said.
   */
  async installFail2ban(actor: ActorContext) {
    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    for (const [step, cmd, t] of [['install', { id: 'f2b.install' }, 300_000], ['enable', { id: 'f2b.enable' }, 30_000], ['start', { id: 'f2b.start' }, 30_000]] as const) {
      const r = await this.host.change(cmd, t);
      steps.push({ step, ok: r.status === 0, ...(r.status === 0 ? {} : { detail: short(r) }) });
      if (r.status !== 0) {
        await this.record(actor, 'HOST_SECURITY_CHANGED', { op: 'fail2ban.install', ok: false, steps });
        this.bust('fail2ban', 'posture');
        this.fail(r, `fail2ban ${step}`);
      }
    }
    await this.record(actor, 'HOST_SECURITY_CHANGED', { op: 'fail2ban.install', ok: true, steps });
    this.bust('fail2ban', 'posture');
    return { steps };
  }

  // ── OS updates ────────────────────────────────────────────────────────────

  getOsUpdates(fresh = false) { return this.cached('os-updates', 300_000, () => this.readOsUpdates(), fresh); }

  private async readOsUpdates(): Promise<OsUpdatesView> {
    const checkedAt = new Date().toISOString();
    const [list, ua] = await Promise.all([this.host.run({ id: 'apt.upgradable' }, 30_000), this.host.run({ id: 'unit.active', unit: 'unattended-upgrades' })]);
    const pkgs = list.status === 0 ? parseAptUpgradable(list.stdout) : null;
    const stamp = this.host.mtime('aptUpdateStamp');
    const uaState = ua.stdout.trim();
    return {
      state: pkgs ? 'ok' : 'unavailable',
      reason: pkgs ? null : `apt list --upgradable could not be read: ${short(list)}`,
      checkedAt,
      total: pkgs ? pkgs.length : null,
      security: pkgs ? pkgs.filter((p) => p.security).length : null,
      packages: pkgs ?? [],
      listsUpdatedAt: stamp ? stamp.toISOString() : null,
      rebootRequired: this.host.exists('rebootRequired'),
      rebootPackages: parseRebootPkgs(this.host.readFile('rebootPkgs')),
      kernel: os.release(),
      unattended: { configured: parseAutoUpgrades(this.host.readFile('autoUpgrades')), serviceActive: uaState === 'active' ? true : uaState ? false : null },
    };
  }

  private updateJob: { running: boolean; phase: string; lines: string[]; exitCode: number | null; startedAt: string; finishedAt: string | null } | null = null;

  /**
   * apt-get update, then apt-get upgrade, as sudoers grants them. One at a
   * time per process. Audited when it starts and when it finishes, with the
   * exit status; the console polls the status route for the output.
   */
  async runOsUpdate(actor: ActorContext) {
    if (this.updateJob?.running) throw new ConflictException({ code: 'UPDATE_RUNNING', message: 'An update is already running.' });
    if (this.host.isTest && !this.host.fixtureMode) throw new ServiceUnavailableException({ code: 'HOST_CHANGES_OFF_IN_TEST', message: 'This is a test process: it changes nothing on the host.' });
    const job = { running: true, phase: 'apt-get update', lines: [] as string[], exitCode: null as number | null, startedAt: new Date().toISOString(), finishedAt: null as string | null };
    this.updateJob = job;
    const push = (l: string) => { job.lines.push(l.slice(0, 500)); if (job.lines.length > 1000) job.lines.splice(0, 200); };
    await this.record(actor, 'HOST_SECURITY_CHANGED', { op: 'os.upgrade', phase: 'started' });
    void (async () => {
      const u = await this.host.change({ id: 'apt.update' }, 300_000, push);
      let r = u;
      if (u.status === 0) { job.phase = 'apt-get upgrade'; r = await this.host.change({ id: 'apt.upgrade' }, 1_800_000, push); }
      else push(`apt-get update failed (${short(u)}); not upgrading.`);
      job.running = false; job.exitCode = r.status; job.finishedAt = new Date().toISOString();
      this.bust('os-updates', 'posture');
      await this.record(actor, 'HOST_SECURITY_CHANGED', { op: 'os.upgrade', phase: 'finished', step: job.phase, exitCode: r.status, ok: r.status === 0 });
    })().catch((e) => { job.running = false; job.exitCode = -1; push(`Error: ${(e as Error).message}`); });
    return { running: true, startedAt: job.startedAt };
  }

  getOsUpdateStatus() {
    const j = this.updateJob;
    if (!j) return { running: false, phase: null, lines: [], exitCode: null, startedAt: null, finishedAt: null };
    return { running: j.running, phase: j.phase, lines: j.lines, exitCode: j.exitCode, startedAt: j.startedAt, finishedAt: j.finishedAt };
  }

  // ── TLS ───────────────────────────────────────────────────────────────────

  getTls(fresh = false) { return this.cached('tls', 120_000, () => this.readTls(), fresh); }

  private async readTls(): Promise<TlsView> {
    const checkedAt = new Date().toISOString();
    const caddy = (await this.host.run({ id: 'unit.active', unit: 'caddy' })).stdout.trim();
    const file = this.host.readFile('caddyfile');
    const domains = parseCaddyDomains(file);
    const now = Date.now();
    const certs = await Promise.all(domains.slice(0, 20).map(async (domain) => {
      const p = await this.host.peerCert(domain);
      const s = certStatus(p.validTo, now);
      return {
        domain, expiresAt: s?.expiresAt ?? null, daysLeft: s?.daysLeft ?? null, level: s?.level ?? 'unknown',
        issuer: p.issuer, trusted: p.authorized, nameMatches: p.nameMatches, error: s ? (p.authorized ? null : p.error ?? 'not trusted') : p.error ?? 'no certificate',
      };
    }));
    return { checkedAt, caddyActive: caddy === 'active' ? true : caddy ? false : null, caddyfileReadable: file !== null, certs };
  }

  // ── Dependency audit ──────────────────────────────────────────────────────

  getDependencyAudit(fresh = false) { return this.cached('deps', 900_000, () => this.readDependencyAudit(), fresh); }

  /**
   * `npm audit --omit=dev` over the API's production manifest and lock, the
   * ones the target installs from (generated by `pnpm deploy:manifest`).
   * Before 0.74 this also ran ESLint and semgrep over a developer's home
   * checkout; in production ESLint linted nothing (every path was outside
   * its base directory, so "no issues") and semgrep could not start as the
   * service user. Source scanning is CI's job, against the source.
   */
  private async readDependencyAudit(): Promise<DependencyAuditView> {
    const scannedAt = new Date().toISOString();
    const dir = this.host.apiDir();
    if (!dir) return { state: 'unavailable', scannedAt, scope: 'API production dependencies', audit: null, reason: 'There is no package-lock.json next to the running API, so npm cannot audit it. A development checkout uses pnpm: run `pnpm audit --prod` there.' };
    const r = await this.host.run({ id: 'npm.audit' }, 90_000);
    const audit = parseNpmAudit(r.stdout);
    if (!audit) return { state: 'unavailable', scannedAt, scope: `API production dependencies (${dir})`, audit: null, reason: `npm audit gave no report: ${short(r)}` };
    return { state: 'ok', reason: null, scannedAt, scope: `API production dependencies (${dir})`, audit };
  }

  // ── Host posture reads ────────────────────────────────────────────────────

  private async readSsh(): Promise<{ checkedAt: string; config: SshdConfig | null; active: boolean | null }> {
    const checkedAt = new Date().toISOString();
    const unit = (await this.host.run({ id: 'unit.active', unit: 'ssh' })).stdout.trim();
    const config = parseSshdConfig({ path: '/etc/ssh/sshd_config', text: this.host.readFile('sshd') }, (p) => this.host.sshdInclude(p));
    return { checkedAt, config, active: unit === 'active' ? true : unit ? false : null };
  }

  private async readFirewall() {
    const checkedAt = new Date().toISOString();
    const [ufw, nft, ss] = await Promise.all([
      this.host.run({ id: 'unit.active', unit: 'ufw' }), this.host.run({ id: 'unit.active', unit: 'nftables' }), this.host.run({ id: 'ss.listening' }),
    ]);
    const listeners = ss.status === 0 ? parseSsListeners(ss.stdout) : null;
    return {
      checkedAt,
      ufwEnabled: parseUfwConf(this.host.readFile('ufw')),
      ufwActive: ufw.stdout.trim() === 'active' ? true : ufw.stdout.trim() ? false : null,
      nftablesActive: nft.stdout.trim() === 'active' ? true : nft.stdout.trim() ? false : null,
      listeners,
      unexpected: listeners ? unexpectedListeners(listeners) : null,
    };
  }

  private async readHeaders() {
    const checkedAt = new Date().toISOString();
    const base = this.urls.webConfigured();
    let host: string | null = null;
    let scheme: string | null = null;
    try { if (base) { const u = new URL(base); host = u.hostname; scheme = u.protocol; } } catch { /* reported below */ }
    if (!host) return { checkedAt, base, host: null, scheme, https: null, http: null, checks: null as HeaderCheck[] | null };
    const [hs, hp] = await Promise.all([this.host.probeHeaders(host, 'https'), this.host.probeHeaders(host, 'http')]);
    return { checkedAt, base, host, scheme, https: hs, http: hp, checks: hs.status ? evaluateHeaders(hs.headers) : null };
  }

  private async readPortal() {
    const checkedAt = new Date().toISOString();
    const active = { status: 'ACTIVE' as const };
    const mfa = { some: { isActive: true, type: { in: ['TOTP', 'WEBAUTHN'] as Array<'TOTP' | 'WEBAUTHN'> } } };
    const [users, usersMfa, admins, breakGlass, keys] = await Promise.all([
      this.prisma.user.count({ where: active }),
      this.prisma.user.count({ where: { ...active, mfaMethods: mfa } }),
      this.prisma.user.findMany({ where: { ...active, isPlatformAdmin: true }, select: { id: true, email: true, breakGlass: true, mfaMethods: { where: { isActive: true }, select: { type: true } } } }),
      this.prisma.user.count({ where: { ...active, breakGlass: true } }),
      this.prisma.apiKey.findMany({ where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { createdAt: true, lastUsedAt: true, expiresAt: true } }),
    ]);
    return { checkedAt, users, usersMfa, admins, breakGlass, keys };
  }

  // ── Posture ───────────────────────────────────────────────────────────────

  getPosture(fresh = false) { return this.cached('posture', 60_000, () => this.buildPosture(fresh), fresh); }

  private async buildPosture(fresh: boolean) {
    const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: Error) => ({ ok: false as const, e: e?.message ?? String(e) }));
    const [ssh, fw, os_, f2b, tls, headers, portal, chain, cfg, deps, signer] = await Promise.all([
      settle(this.readSsh()), settle(this.readFirewall()), settle(this.getOsUpdates(fresh)), settle(this.getFail2ban(fresh)), settle(this.getTls(fresh)),
      settle(this.readHeaders()), settle(this.readPortal()), settle(this.chain.status()), settle(this.getConfig()), settle(this.getDependencyAudit(fresh)),
      settle(this.signer.configured() ? this.signer.capabilities() : Promise.resolve(null)),
    ]);
    const now = new Date().toISOString();
    const F: Finding[] = [];
    const add = (f: Omit<Finding, 'checkedAt'> & { checkedAt?: string }) => F.push({ ...f, checkedAt: f.checkedAt ?? now });
    const unknown = (id: string, area: Finding['area'], title: string, severity: Severity, evidence: string, fix?: string, checkedAt?: string) =>
      add({ id, area, title, status: 'unknown', severity, evidence, fix, checkedAt });

    // SSH
    if (!ssh.ok || !ssh.v.config) {
      for (const [id, t, s] of [['host.ssh.root_login', 'SSH: root cannot sign in with a password', 'high'], ['host.ssh.password_auth', 'SSH: passwords are not accepted', 'medium']] as const)
        unknown(id, 'host', t, s, ssh.ok ? '/etc/ssh/sshd_config is not readable by the API user.' : ssh.e, 'Run `sudo sshd -T | grep -Ei "permitrootlogin|passwordauthentication"` on the server.');
    } else {
      const c = ssh.v.config;
      const at = ssh.v.checkedAt;
      const why = (k: keyof typeof c.values) => {
        const v = c.values[k];
        return `${k} ${v.value} (${v.source === 'default' ? 'OpenSSH default' : v.source})${v.uncertain ? `; ${c.unreadable.join(', ')} could not be read and is read first` : ''}`;
      };
      const root = c.values.permitrootlogin;
      if (root.uncertain) unknown('host.ssh.root_login', 'host', 'SSH: root cannot sign in with a password', 'high', why('permitrootlogin'), 'Run `sudo sshd -T | grep -i permitrootlogin` to see the effective value.', at);
      else add({ id: 'host.ssh.root_login', area: 'host', title: 'SSH: root cannot sign in with a password', checkedAt: at,
        status: root.value === 'yes' ? 'fail' : 'pass', severity: 'high', evidence: why('permitrootlogin'),
        fix: 'Set `PermitRootLogin prohibit-password` (or `no`) in /etc/ssh/sshd_config and run `sudo systemctl reload ssh`.' });
      const pw = c.values.passwordauthentication;
      if (pw.uncertain) unknown('host.ssh.password_auth', 'host', 'SSH: passwords are not accepted', 'medium', why('passwordauthentication'), 'Run `sudo sshd -T | grep -i passwordauthentication` to see the effective value.', at);
      else add({ id: 'host.ssh.password_auth', area: 'host', title: 'SSH: passwords are not accepted', checkedAt: at,
        status: pw.value === 'no' ? 'pass' : 'fail', severity: 'medium', evidence: why('passwordauthentication'),
        fix: 'Once every administrator has an SSH key, set `PasswordAuthentication no` and reload ssh. Until then keep the fail2ban sshd jail on.' });
      const empty = c.values.permitemptypasswords;
      if (!empty.uncertain) add({ id: 'host.ssh.empty_passwords', area: 'host', title: 'SSH: empty passwords are refused', checkedAt: at,
        status: empty.value === 'yes' ? 'fail' : 'pass', severity: 'critical', evidence: why('permitemptypasswords'), fix: 'Set `PermitEmptyPasswords no` and reload ssh.' });
      const x11 = c.values.x11forwarding;
      if (!x11.uncertain) add({ id: 'host.ssh.x11', area: 'host', title: 'SSH: X11 forwarding is off', checkedAt: at,
        status: x11.value === 'yes' ? 'fail' : 'pass', severity: 'low', evidence: why('x11forwarding'), fix: 'A server has no display: set `X11Forwarding no` and reload ssh.' });
    }

    // Firewall and listeners
    if (!fw.ok) unknown('host.firewall', 'network', 'A host firewall is on', 'high', fw.e);
    else {
      const v = fw.v;
      const on = v.ufwActive === true && v.ufwEnabled === true ? 'ufw' : v.nftablesActive === true ? 'nftables' : null;
      if (on) add({ id: 'host.firewall', area: 'network', title: 'A host firewall is on', checkedAt: v.checkedAt, status: 'pass', severity: 'high',
        evidence: on === 'ufw' ? 'ufw is enabled (ufw.conf ENABLED=yes) and its service is active. Its rules need root to read: `sudo ufw status verbose`.' : 'The nftables service is active.' });
      else if (v.ufwActive === null && v.nftablesActive === null) unknown('host.firewall', 'network', 'A host firewall is on', 'high', 'systemctl gave no answer for ufw or nftables.', undefined, v.checkedAt);
      else add({ id: 'host.firewall', area: 'network', title: 'A host firewall is on', checkedAt: v.checkedAt, status: 'fail', severity: 'high',
        evidence: `ufw: ${v.ufwEnabled === null ? 'not configured' : v.ufwEnabled ? 'enabled' : 'disabled'}, service ${v.ufwActive ? 'active' : 'inactive'}; nftables service ${v.nftablesActive ? 'active' : 'inactive'}.`,
        fix: 'Allow 22, 80, 443 and 21115–21119 (21116 also UDP), then `sudo ufw enable`. If the firewall is upstream (a cloud security group), this finding is expected.' });
      if (!v.listeners) unknown('network.listeners', 'network', 'Only expected services listen publicly', 'medium', 'ss gave no answer.', undefined, v.checkedAt);
      else {
        const u = v.unexpected ?? [];
        const fmt = (l: Listener) => `${l.proto}/${l.port} on ${l.address}`;
        add({ id: 'network.listeners', area: 'network', title: 'Only expected services listen publicly', checkedAt: v.checkedAt,
          status: u.length ? 'fail' : 'pass', severity: 'medium',
          evidence: u.length ? `Not loopback and not expected: ${u.slice(0, 12).map(fmt).join(', ')}${u.length > 12 ? ` and ${u.length - 12} more` : ''}.` : `${v.listeners.filter((l) => !l.loopback).length} public sockets, all expected (SSH, Caddy, RustDesk).`,
          fix: 'Find the owner with `sudo ss -tulpn`; bind it to 127.0.0.1 or close the port in the firewall.' });
      }
    }

    // OS updates
    if (!os_.ok || os_.v.state !== 'ok') unknown('host.updates.security', 'host', 'No security updates are waiting', 'high', os_.ok ? os_.v.reason ?? 'unavailable' : os_.e);
    else {
      const v = os_.v;
      add({ id: 'host.updates.security', area: 'host', title: 'No security updates are waiting', checkedAt: v.checkedAt, status: v.security ? 'fail' : 'pass', severity: 'high',
        evidence: v.security ? `${v.security} security update(s) of ${v.total} pending: ${v.packages.filter((p) => p.security).slice(0, 8).map((p) => p.name).join(', ')}.` : `${v.total} update(s) pending, none from a security pocket.`,
        fix: 'Run them from OS Updates, or `sudo apt-get upgrade` on the server.' });
      if (v.total) add({ id: 'host.updates.other', area: 'host', title: 'Other package updates are applied', checkedAt: v.checkedAt, status: 'fail', severity: 'low',
        evidence: `${v.total} package(s) upgradable.`, fix: 'Apply them from OS Updates in a quiet hour.' });
      const age = v.listsUpdatedAt ? (Date.now() - Date.parse(v.listsUpdatedAt)) / 3_600_000 : null;
      if (age === null) unknown('host.updates.lists', 'host', 'Package lists are current', 'medium', 'No apt update stamp (/var/lib/apt/periodic/update-success-stamp).', 'Run `sudo apt-get update`.', v.checkedAt);
      else add({ id: 'host.updates.lists', area: 'host', title: 'Package lists are current', checkedAt: v.checkedAt, status: age > 48 ? 'fail' : 'pass', severity: 'medium',
        evidence: `Last successful apt update ${Math.round(age)} h ago (${v.listsUpdatedAt}). The counts above are only as new as this.`, fix: 'Run `sudo apt-get update`, and check the apt-daily timer: `systemctl status apt-daily.timer`.' });
      const cfgU = v.unattended.configured;
      if (!cfgU || v.unattended.serviceActive === null) unknown('host.updates.unattended', 'host', 'Unattended security upgrades are on', 'medium', cfgU ? 'systemctl gave no answer for unattended-upgrades.' : '/etc/apt/apt.conf.d/20auto-upgrades is missing or unreadable.', 'Run `sudo dpkg-reconfigure -plow unattended-upgrades`.', v.checkedAt);
      else add({ id: 'host.updates.unattended', area: 'host', title: 'Unattended security upgrades are on', checkedAt: v.checkedAt,
        status: cfgU.updateLists && cfgU.unattended && v.unattended.serviceActive ? 'pass' : 'fail', severity: 'medium',
        evidence: `Update-Package-Lists ${cfgU.updateLists ? 'on' : 'off'}, Unattended-Upgrade ${cfgU.unattended ? 'on' : 'off'}, service ${v.unattended.serviceActive ? 'active' : 'inactive'}.`,
        fix: 'Run `sudo dpkg-reconfigure -plow unattended-upgrades` and `sudo systemctl enable --now unattended-upgrades`.' });
      add({ id: 'host.reboot', area: 'host', title: 'No restart is pending', checkedAt: v.checkedAt, status: v.rebootRequired ? 'fail' : 'pass', severity: 'medium',
        evidence: v.rebootRequired ? `A restart is pending for: ${v.rebootPackages.join(', ') || '(no package list)'}. Running kernel ${v.kernel}; a newer kernel's fixes are not in effect until the restart.` : `Running kernel ${v.kernel}; nothing is waiting for a restart.`,
        fix: 'Restart the server in a quiet hour. Rem0te, Caddy and the RustDesk server start on boot.' });
    }

    // fail2ban
    if (!f2b.ok || f2b.v.state === 'unavailable') unknown('host.fail2ban', 'host', 'fail2ban is running with an sshd jail', 'high', f2b.ok ? f2b.v.reason ?? 'unavailable' : f2b.e, undefined, f2b.ok ? f2b.v.checkedAt : undefined);
    else {
      const v = f2b.v;
      const sshd = v.jails.some((j) => j.jail === 'sshd');
      add({ id: 'host.fail2ban', area: 'host', title: 'fail2ban is running with an sshd jail', checkedAt: v.checkedAt,
        status: v.state === 'running' && sshd ? 'pass' : 'fail', severity: 'high',
        evidence: v.state === 'running' ? `Running; jails: ${v.jails.map((j) => j.jail).join(', ') || 'none'}.` : `fail2ban is ${v.state.replace('_', ' ')}.`,
        fix: v.state === 'running' ? 'Enable the sshd jail in /etc/fail2ban/jail.local and `sudo systemctl restart fail2ban`.' : 'Install or start it from the fail2ban tab.' });
      const sj = v.jails.find((j) => j.jail === 'sshd');
      const other = sj && ssh.ok && ssh.v.active ? jailWatchesOtherUnit(sj.journalMatches ?? null, 'ssh.service') : null;
      if (sj && other) add({ id: 'host.fail2ban.sshd_unit', area: 'host', title: "fail2ban's sshd jail reads the SSH server's log", checkedAt: v.checkedAt, status: 'fail', severity: 'medium',
        evidence: `The jail matches journal entries from ${other}, but this host's SSH server runs as ssh.service, so it may never see a failed sign-in (total failed so far: ${sj.totalFailed ?? 'unknown'}).`,
        fix: 'In /etc/fail2ban/jail.local, under [sshd], set `journalmatch = _SYSTEMD_UNIT=ssh.service + _COMM=sshd` (or `backend = auto` with `logpath = /var/log/auth.log`), then `sudo systemctl restart fail2ban` and check `sudo fail2ban-client status sshd` counts failures.' });
    }

    // TLS and headers
    if (!tls.ok) unknown('web.tls', 'web', 'TLS certificates are valid', 'critical', tls.e);
    else if (!tls.v.certs.length) unknown('web.tls', 'web', 'TLS certificates are valid', 'critical', tls.v.caddyfileReadable ? 'The Caddyfile names no TLS site.' : '/etc/caddy/Caddyfile is not readable by the API user.', undefined, tls.v.checkedAt);
    else for (const c of tls.v.certs) {
      const title = `TLS: ${c.domain}`;
      if (c.daysLeft === null) { unknown(`web.tls.${c.domain}`, 'web', title, 'critical', `No certificate read over loopback: ${c.error ?? 'unknown'}.`, 'Check `journalctl -u caddy` for ACME errors.', tls.v.checkedAt); continue; }
      const bad = c.level !== 'ok' || !c.trusted || !c.nameMatches;
      add({ id: `web.tls.${c.domain}`, area: 'web', title, checkedAt: tls.v.checkedAt, status: bad ? 'fail' : 'pass',
        severity: c.level === 'expired' || c.level === 'urgent' || !c.trusted || !c.nameMatches ? 'critical' : 'high',
        evidence: `${c.issuer ?? 'unknown issuer'}; expires ${c.expiresAt} (${c.daysLeft} days)${c.trusted ? '' : `; not trusted: ${c.error}`}${c.nameMatches ? '' : '; the name does not match'}.`,
        fix: c.level === 'ok' ? 'Check the chain and name with `openssl s_client -connect 127.0.0.1:443 -servername ' + c.domain + '`.' : 'Caddy renews about 30 days before expiry, so this means renewal is failing: check `journalctl -u caddy | grep -i acme` and that DNS and port 80 reach this server.' });
    }
    if (!headers.ok) unknown('web.headers', 'web', 'Security headers', 'medium', headers.e);
    else {
      const h = headers.v;
      if (!h.host) unknown('web.public_https', 'web', 'The public address is HTTPS', 'high', 'No public address is set (Settings → General → Public address, or FRONTEND_URL).', undefined, h.checkedAt);
      else {
        add({ id: 'web.public_https', area: 'web', title: 'The public address is HTTPS', checkedAt: h.checkedAt, status: h.scheme === 'https:' ? 'pass' : 'fail', severity: 'high',
          evidence: `Public address ${h.base}.`, fix: 'Set an https:// public address under Settings → General.', link: '/settings' });
        if (!h.checks) unknown('web.headers', 'web', 'Security headers', 'medium', `No answer from Caddy for ${h.host} over loopback: ${h.https?.error ?? `HTTP ${h.https?.status}`}.`, undefined, h.checkedAt);
        else for (const c of h.checks) {
          const sev: Severity = c.id === 'hsts' ? 'high' : c.id === 'csp' || c.id === 'framing' ? 'medium' : c.id === 'server' || c.id === 'powered' ? 'info' : 'low';
          add({ id: `web.header.${c.id}`, area: 'web', title: `Header: ${c.header}`, checkedAt: h.checkedAt,
            status: c.verdict === 'ok' ? 'pass' : c.verdict === 'disclosed' ? 'info' : 'fail', severity: sev,
            evidence: `${c.value ? `${c.value.slice(0, 160)}. ` : ''}${c.detail}`,
            fix: c.verdict === 'ok' ? undefined : `Add it in the site's \`header\` block of /etc/caddy/Caddyfile, then \`sudo systemctl reload caddy\`.` });
        }
        const r = h.http;
        if (r && r.status) add({ id: 'web.http_redirect', area: 'web', title: 'Plain HTTP redirects to HTTPS', checkedAt: h.checkedAt,
          status: [301, 302, 307, 308].includes(r.status) && /^https:\/\//.test(r.location ?? '') ? 'pass' : 'fail', severity: 'medium',
          evidence: `http://${h.host}/ answers ${r.status}${r.location ? ` → ${r.location}` : ''}.`, fix: 'Caddy redirects automatically for a site named by its domain; check the Caddyfile has no plain http:// block for it.' });
      }
    }

    // Portal
    if (!portal.ok) unknown('portal.mfa.admins', 'portal', 'Every Platform Admin has MFA', 'critical', portal.e);
    else {
      const p = portal.v;
      const noMfa = p.admins.filter((a) => !a.mfaMethods.some((m) => m.type === 'TOTP' || m.type === 'WEBAUTHN'));
      add({ id: 'portal.mfa.admins', area: 'portal', title: 'Every Platform Admin has MFA', checkedAt: p.checkedAt, status: noMfa.length ? 'fail' : 'pass', severity: 'critical',
        evidence: noMfa.length ? `Without an authenticator or passkey: ${noMfa.map((a) => a.email).join(', ')}.` : `${p.admins.length} active Platform Admin(s), all with an authenticator or passkey.`,
        fix: 'Each of them sets one up under Account → Security.', link: '/users' });
      const pct = p.users ? Math.round((p.usersMfa / p.users) * 100) : 100;
      add({ id: 'portal.mfa.users', area: 'portal', title: 'Accounts have MFA', checkedAt: p.checkedAt, status: p.usersMfa === p.users ? 'pass' : 'fail', severity: 'medium',
        evidence: `${p.usersMfa} of ${p.users} active accounts (${pct}%) have an authenticator or passkey.`,
        fix: 'Turn on Require MFA (Settings → Security) so every account sets one up at its next sign-in.', link: '/settings' });
      const weakBg = p.admins.filter((a) => a.breakGlass && !(a.mfaMethods.some((m) => m.type === 'TOTP') && a.mfaMethods.some((m) => m.type === 'WEBAUTHN')));
      add({ id: 'portal.admins', area: 'portal', title: 'Platform Admins and break-glass accounts', checkedAt: p.checkedAt, status: weakBg.length ? 'fail' : 'info', severity: weakBg.length ? 'high' : 'info',
        evidence: `${p.admins.length} Platform Admin(s), ${p.breakGlass} break-glass account(s)${weakBg.length ? `; break-glass without both an authenticator and a passkey: ${weakBg.map((a) => a.email).join(', ')}` : ''}.`,
        fix: weakBg.length ? 'A break-glass account needs both; see Settings → Single sign-on.' : undefined, link: '/admin/sso' });
      const day = 86_400_000;
      const never = p.keys.filter((k) => !k.expiresAt).length;
      const stale = p.keys.filter((k) => (k.lastUsedAt ?? k.createdAt).getTime() < Date.now() - 90 * day).length;
      add({ id: 'portal.apikeys', area: 'portal', title: 'API keys expire and are in use', checkedAt: p.checkedAt, status: never || stale ? 'fail' : p.keys.length ? 'pass' : 'info', severity: 'low',
        evidence: p.keys.length ? `${p.keys.length} active key(s): ${never} never expire, ${stale} unused for 90 days or more; oldest created ${new Date(Math.min(...p.keys.map((k) => k.createdAt.getTime()))).toISOString().slice(0, 10)}.` : 'No active API keys.',
        fix: 'Revoke keys nobody uses and re-issue the rest with an expiry (Settings → API keys).', link: '/settings/api-keys' });
    }
    if (!chain.ok) unknown('portal.audit_chain', 'portal', 'The audit chain verifies', 'critical', chain.e);
    else {
      const c = chain.v;
      if (c.verify.ok === null) unknown('portal.audit_chain', 'portal', 'The audit chain verifies', 'critical', 'The chain has not been verified in this database yet (it runs at start and hourly).', 'Verify it now from Audit → Integrity.', c.verify.at?.toISOString());
      else add({ id: 'portal.audit_chain', area: 'portal', title: 'The audit chain verifies', checkedAt: c.verify.at?.toISOString() ?? now, status: c.verify.ok ? 'pass' : 'fail', severity: 'critical',
        evidence: c.verify.ok ? `${c.verify.checked} sealed entries verified through #${c.verify.throughSeq}.` : `${c.verify.problems.length} problem(s), first: ${c.verify.problems[0]?.kind} at #${c.verify.problems[0]?.seq}.`,
        fix: 'See Settings → Security → Containment (audit integrity), and compare with the off-host export (`audit verify --export`).', link: '/settings/security/containment' });
      add({ id: 'portal.audit_export', area: 'portal', title: 'Audit entries are exported off the host', checkedAt: now, status: c.export.configured.length && !c.export.error ? 'pass' : 'fail', severity: 'medium',
        evidence: c.export.configured.length ? `Exporting to ${c.export.configured.join(', ')}${c.export.error ? `; last error: ${c.export.error}` : ''}.` : 'AUDIT_EXPORT_FILE and AUDIT_EXPORT_URL are unset: someone with this host could rewrite the chain and its proof together.',
        fix: 'Set AUDIT_EXPORT_URL (or AUDIT_EXPORT_FILE on another disk) in /etc/reboot-remote/api.env.', link: '/settings/security/containment' });
    }
    if (!cfg.ok) unknown('portal.lockout', 'portal', 'Accounts lock after repeated failed sign-ins', 'high', cfg.e);
    else {
      const c = cfg.v;
      add({ id: 'portal.lockout', area: 'portal', title: 'Accounts lock after repeated failed sign-ins', status: c.maxLoginAttempts > 0 && c.maxLoginAttempts <= 10 ? 'pass' : 'fail', severity: 'high',
        evidence: c.maxLoginAttempts === 0 ? 'The lockout is off (0 attempts).' : `${c.maxLoginAttempts} failed attempts lock an account for ${c.lockoutMinutes} minutes.`,
        fix: 'Set 5 to 10 attempts under Access Rules.' });
      const u = c.unenforced;
      const on = u.geoipBlockEnabled || u.ipAllowlistEnabled || u.blockedCountries.length + u.blockedIpRanges.length + u.allowedIpRanges.length > 0;
      if (on) add({ id: 'portal.unenforced_rules', area: 'portal', title: 'No stored access rule pretends to protect', status: 'fail', severity: 'medium',
        evidence: `Stored but never enforced: GeoIP blocking ${u.geoipBlockEnabled ? 'on' : 'off'} (${u.blockedCountries.length} countries), IP allowlist ${u.ipAllowlistEnabled ? 'on' : 'off'} (${u.allowedIpRanges.length} ranges), ${u.blockedIpRanges.length} blocked ranges.`,
        fix: 'Nothing in Rem0te reads these. Clear them under Access Rules, and block addresses in the firewall or Caddy instead.' });
    }

    // Signed releases, approval signer, MSA
    const trust = this.updateTrust.status();
    if (!trust.configured) add({ id: 'portal.signed_releases', area: 'portal', title: 'Signed agent releases are published', status: 'info', severity: 'info', evidence: trust.reason ?? 'Not configured.', link: '/settings/security/update-signing' });
    else add({ id: 'portal.signed_releases', area: 'portal', title: 'Signed agent release metadata is valid', status: trust.warnings.length ? 'fail' : 'pass', severity: 'high',
      evidence: trust.warnings.length ? trust.warnings.join(' ') : `Timestamp expires ${trust.roles?.timestamp.expires}; root threshold ${trust.roles?.root.threshold}.`,
      fix: 'Re-sign and publish on the release host (see docs/signed-releases.md).', link: '/settings/security/update-signing' });
    // Whether the root keys are still on this host can only be read by the
    // release user (§56: the portal never names that directory). The page
    // shows the command to run.
    unknown('portal.release_root_keys', 'portal', 'Signing root keys are off the host', 'high', 'Only the release user can see the key directory; the portal is deliberately unable to read it.', 'Run the release status command on the server (shown on the page).');
    if (!this.signer.configured()) add({ id: 'portal.approval_signer', area: 'portal', title: 'Approval signer', status: 'info', severity: 'info', evidence: 'No approval signer is configured (APPROVAL_SIGNER_INTERNAL_URL): approved actions are off.' });
    else if (!signer.ok) add({ id: 'portal.approval_signer', area: 'portal', title: 'The approval signer answers', status: 'fail', severity: 'high', evidence: signer.e, fix: 'Check `systemctl status rem0te-approval-signer`.' });
    else add({ id: 'portal.approval_signer', area: 'portal', title: 'The approval signer answers', status: signer.v && signer.v.status === 200 ? 'pass' : 'fail', severity: 'high',
      evidence: signer.v?.status === 200 ? `Answering; key ${signer.v.body.kid ?? 'unknown'}; ${signer.v.body.roster?.approvers ?? '?'} approver(s); default mode ${signer.v.body.approval?.default ?? 'signed'}.` : `HTTP ${signer.v?.status}.`,
      fix: 'Check `systemctl status rem0te-approval-signer`.' });
    add({ id: 'process.msa_grants', area: 'process', title: 'Managed Secure Access grants', status: 'info', severity: 'info',
      evidence: msaGrantsEnabled() ? 'MSA_GRANTS=on: the grant routes and long-poll are live.' : 'MSA_GRANTS is off: the grant routes answer 404 MSA_NOT_ENABLED.' });

    // Process switches
    F.push(nodeEnvFinding(process.env, now));
    for (const s of offSwitches(process.env)) add({ id: `process.switch.${s.name}`, area: 'process', title: `${s.name}=off`, status: 'fail', severity: s.severity,
      evidence: s.cost, fix: `Remove ${s.name}=off from /etc/reboot-remote/api.env and restart the API. It exists for test stacks.` });

    // Dependencies
    if (!deps.ok || deps.v.state !== 'ok' || !deps.v.audit) unknown('deps.npm', 'host', 'No known-vulnerable API dependencies', 'high', deps.ok ? deps.v.reason ?? 'unavailable' : deps.e, undefined, deps.ok ? deps.v.scannedAt : undefined);
    else {
      const c = deps.v.audit.counts;
      add({ id: 'deps.npm', area: 'host', title: 'No known-vulnerable API dependencies', checkedAt: deps.v.scannedAt, status: c.critical + c.high ? 'fail' : 'pass', severity: c.critical ? 'critical' : 'high',
        evidence: `npm audit (production): ${c.critical} critical, ${c.high} high, ${c.moderate} moderate, ${c.low} low over ${deps.v.audit.dependencies ?? '?'} packages.`,
        fix: 'Bump the dependency in the repository and deploy with a regenerated manifest (CLAUDE.md, "Deploying"); never `npm audit fix` on the server.' });
    }

    F.sort((a, b) => {
      const st = { fail: 0, unknown: 1, pass: 2, info: 3 } as const;
      return st[a.status] - st[b.status] || sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity) || a.id.localeCompare(b.id);
    });
    return { generatedAt: now, summary: scoreOf(F), findings: F };
  }
}
