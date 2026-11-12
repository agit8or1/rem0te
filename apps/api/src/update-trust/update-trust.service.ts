import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { ActorContext } from '../rbac/access-control.service';
import { TrustChangeService } from '../security-controls/trust-change.service';

/**
 * The portal's side of the signed update chain: a read-only mirror.
 *
 * The repository under UPDATE_REPO_DIR is written offline by
 * `rem0te-release` (tools/windows-installer/cmd/rem0te-release) and copied
 * here. This service serves those files byte-for-byte and never signs
 * anything — there is no key on this host for it to use. What it reports about
 * versions and expiry is "as served", parsed without verification: the agent's
 * verification is the one that counts, and a portal that could vouch for the
 * metadata would be a portal whose compromise mattered.
 */

export type UpdateTrustMode = 'legacy_allowed' | 'signed_only';
export const UPDATE_TRUST_MODES: UpdateTrustMode[] = ['legacy_allowed', 'signed_only'];

const META_RE = /^(?:[1-9][0-9]{0,6}\.(?:root|targets|snapshot)|timestamp|root)\.json$/;
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const AGENT_TARGET = 'windows/rem0te-agent.exe';
/** The tray (0.36): the same signed bytes the standard agent's installer downloads and pins. */
const TRAY_TARGET = 'windows/rem0te-tray.exe';
const INSTALLER_TARGET = 'windows/install.ps1';

interface Role { version: number; expires: string }
interface TargetEntry { length: number; hashes: { sha256?: string }; custom?: Record<string, unknown> }

export interface MirrorStatus {
  configured: boolean;
  reason?: string;
  roles?: { root: Role & { threshold: number; keys: number }; targets: Role; snapshot: Role; timestamp: Role };
  targets?: { name: string; length: number; sha256: string; custom?: Record<string, unknown> }[];
  warnings: string[];
}

@Injectable()
export class UpdateTrustService {
  private readonly logger = new Logger(UpdateTrustService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly trust: TrustChangeService,
  ) {}

  /** Absolute repository directory, or null when unset. */
  repoDir(): string | null {
    const d = process.env.UPDATE_REPO_DIR?.trim();
    if (!d || !path.isAbsolute(d)) return null;
    return d;
  }

  isConfigured(): boolean {
    const d = this.repoDir();
    return !!d && fs.existsSync(path.join(d, 'metadata', 'root.json')) && fs.existsSync(path.join(d, 'metadata', 'timestamp.json'));
  }

  // ── Mirror ────────────────────────────────────────────────────────────────

  /** Resolve a metadata file name to a path inside the repository, or 404. */
  metadataPath(file: string): string {
    const d = this.repoDir();
    if (!d || !META_RE.test(file)) throw new NotFoundException();
    return this.contained(path.join(d, 'metadata'), [file]);
  }

  /**
   * Resolve a target path (`windows/<sha256>.install.ps1`). Every segment is
   * checked against a strict charset, the result must stay inside targets/
   * after symlinks are resolved, and it must be a regular file.
   */
  targetPath(segments: string[]): string {
    const d = this.repoDir();
    if (!d || segments.length === 0 || segments.length > 5 || !segments.every((s) => SEGMENT_RE.test(s) && !s.includes('..'))) {
      throw new NotFoundException();
    }
    return this.contained(path.join(d, 'targets'), segments);
  }

  private contained(base: string, segments: string[]): string {
    let realBase: string;
    let real: string;
    try {
      realBase = fs.realpathSync(base);
      real = fs.realpathSync(path.join(base, ...segments));
    } catch {
      throw new NotFoundException();
    }
    if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new NotFoundException();
    if (!fs.statSync(real).isFile()) throw new NotFoundException();
    return real;
  }

  // ── Status (as served, unverified) ────────────────────────────────────────

  private readJson<T>(p: string): T | null {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; }
  }

  private loadServed() {
    const d = this.repoDir();
    if (!d) return null;
    const m = (f: string) => this.readJson<{ signed: Record<string, unknown> }>(path.join(d, 'metadata', f));
    const root = m('root.json');
    const ts = m('timestamp.json');
    if (!root || !ts) return null;
    const snapV = (ts.signed.meta as Record<string, { version: number }>)?.['snapshot.json']?.version;
    const snap = snapV ? m(`${snapV}.snapshot.json`) : null;
    const tgV = (snap?.signed.meta as Record<string, { version: number }> | undefined)?.['targets.json']?.version;
    const targets = tgV ? m(`${tgV}.targets.json`) : null;
    return { root, ts, snap, targets };
  }

  status(now = new Date()): MirrorStatus {
    const warnings: string[] = [];
    if (!this.repoDir()) return { configured: false, reason: 'UPDATE_REPO_DIR is not set (or not an absolute path).', warnings };
    const s = this.loadServed();
    if (!s || !s.snap || !s.targets) return { configured: false, reason: 'The repository is incomplete: root.json, timestamp.json, and the snapshot and targets they name must all be present.', warnings };
    const role = (x: { signed: Record<string, unknown> }): Role => ({ version: Number(x.signed.version), expires: String(x.signed.expires) });
    const rootRoles = s.root.signed.roles as Record<string, { keyids: string[]; threshold: number }>;
    const roles = {
      root: { ...role(s.root), threshold: rootRoles.root?.threshold ?? 0, keys: rootRoles.root?.keyids.length ?? 0 },
      targets: role(s.targets), snapshot: role(s.snap), timestamp: role(s.ts),
    };
    for (const [name, r] of Object.entries(roles)) {
      const left = new Date(r.expires).getTime() - now.getTime();
      if (left <= 0) warnings.push(`${name} metadata has expired: every agent will refuse updates until it is re-signed.`);
      else if (left < 48 * 3600_000) warnings.push(`${name} metadata expires within 48 hours (${r.expires}).`);
    }
    if (roles.root.threshold < 2) warnings.push('Root threshold is 1: a single stolen root key can re-key the whole chain.');
    const entries = (s.targets.signed.targets ?? {}) as Record<string, TargetEntry>;
    const targets = Object.entries(entries).map(([name, t]) => ({ name, length: t.length, sha256: t.hashes?.sha256 ?? '', ...(t.custom ? { custom: t.custom } : {}) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries[AGENT_TARGET]) warnings.push(`No ${AGENT_TARGET} target: the signed bootstrap cannot install.`);
    if (!entries[INSTALLER_TARGET]) warnings.push(`No ${INSTALLER_TARGET} target: the signed bootstrap cannot install.`);
    return { configured: true, roles, targets, warnings };
  }

  /** The served file for a named target, by its signed digest. */
  targetFile(name: string): { path: string; sha256: string; length: number } | null {
    const s = this.loadServed();
    const t = (s?.targets?.signed.targets as Record<string, TargetEntry> | undefined)?.[name];
    const sha = t?.hashes?.sha256;
    if (!t || !sha || !/^[0-9a-f]{64}$/.test(sha)) return null;
    const segs = name.split('/');
    segs[segs.length - 1] = `${sha}.${segs[segs.length - 1]}`;
    try { return { path: this.targetPath(segs), sha256: sha, length: t.length }; } catch { return null; }
  }

  agentTarget() { return this.targetFile(AGENT_TARGET); }
  trayTarget() { return this.targetFile(TRAY_TARGET); }

  /** Signed RustDesk builds, newest first, from targets custom metadata or name. */
  signedRustdeskVersions(): string[] {
    const s = this.loadServed();
    const names = Object.keys((s?.targets?.signed.targets ?? {}) as Record<string, unknown>);
    return names
      .map((n) => /^windows\/rustdesk\/rustdesk-([0-9.]{3,32})-x86_64\.exe$/.exec(n)?.[1])
      .filter((v): v is string => !!v && dottedVersion(v))
      .sort((a, b) => cmp(b, a));
  }

  // ── Mode ──────────────────────────────────────────────────────────────────

  async mode(): Promise<{ mode: UpdateTrustMode; legacyPortalMigration: boolean }> {
    const s = await this.prisma.platformSettings.findUnique({ where: { id: 'singleton' }, select: { updateTrustMode: true, legacyPortalMigration: true } });
    const mode = (UPDATE_TRUST_MODES as string[]).includes(s?.updateTrustMode ?? '') ? (s!.updateTrustMode as UpdateTrustMode) : 'legacy_allowed';
    return { mode, legacyPortalMigration: !!s?.legacyPortalMigration };
  }

  /**
   * Tightening (→ signed_only, or turning portal migration off) applies at
   * once. Loosening (→ legacy_allowed, or turning portal migration on) widens
   * what a compromised portal can execute on legacy agents, so it goes to an
   * independent reviewer like every other trust widening.
   */
  async setMode(actor: ActorContext, next: { mode: UpdateTrustMode; legacyPortalMigration: boolean }) {
    if (!UPDATE_TRUST_MODES.includes(next.mode)) throw new BadRequestException('Unknown update trust mode');
    if (next.mode === 'signed_only' && !this.isConfigured()) {
      throw new BadRequestException({ code: 'UPDATE_REPO_NOT_CONFIGURED', message: 'Signed-only needs a signed update repository (UPDATE_REPO_DIR). Without one no agent could install or update at all.' });
    }
    const cur = await this.mode();
    const widening: string[] = [];
    if (cur.mode === 'signed_only' && next.mode === 'legacy_allowed') widening.push('legacy agents may run portal-served installers again');
    if (!cur.legacyPortalMigration && next.legacyPortalMigration) widening.push('legacy agents may fetch a portal-served migration script');
    if (widening.length) {
      return this.trust.request(actor, { kind: 'update_trust', target: 'singleton', before: cur, after: next, payload: next, widening });
    }
    const data = { updateTrustMode: next.mode, legacyPortalMigration: next.legacyPortalMigration };
    await this.prisma.platformSettings.upsert({ where: { id: 'singleton' }, update: data, create: { id: 'singleton', ...data } });
    await this.audit.log({ actorId: actor.userId, action: 'PLATFORM_SETTINGS_UPDATED', resource: 'update_trust', resourceId: 'singleton', meta: { before: cur, after: next } });
    return { pendingReview: false, ...next };
  }

  // ── Containment, per heartbeat ────────────────────────────────────────────

  /**
   * What a heartbeat may hand this agent. A legacy agent's only update path is
   * `irm | iex` of the portal's installer: in signed_only it gets nothing to
   * run, or (with portal migration on) only the migration flag.
   */
  async gateForHeartbeat(channel: 'signed' | 'legacy'): Promise<'pass' | 'withhold' | 'migrate'> {
    if (channel === 'signed') return 'pass';
    const m = await this.mode();
    if (m.mode === 'legacy_allowed') return 'pass';
    return m.legacyPortalMigration && this.agentTarget() ? 'migrate' : 'withhold';
  }

  // ── Inventory ─────────────────────────────────────────────────────────────

  async inventory() {
    const served = this.status();
    const rootV = served.roles?.root.version ?? null;
    const rows = await this.prisma.endpoint.findMany({
      where: { platform: { equals: 'Windows', mode: 'insensitive' } },
      select: { id: true, hostname: true, name: true, agentVersion: true, updateChannel: true, trustRootVersion: true, targetsVersion: true, trustReportedAt: true, lastSeenAt: true, isOnline: true, tenantId: true, customer: { select: { id: true, name: true } } },
      orderBy: { lastSeenAt: 'desc' },
      take: 2000,
    });
    const counts = { signed: 0, legacy: 0, signedBehindRoot: 0 };
    const legacy: typeof rows = [];
    const behind: typeof rows = [];
    for (const r of rows) {
      if (r.updateChannel === 'signed') {
        counts.signed++;
        if (rootV && (r.trustRootVersion ?? 0) < rootV) { counts.signedBehindRoot++; behind.push(r); }
      } else { counts.legacy++; legacy.push(r); }
    }
    const shape = (r: (typeof rows)[number]) => ({
      id: r.id, hostname: r.hostname ?? r.name, business: r.customer ? { id: r.customer.id, name: r.customer.name } : null,
      agentVersion: r.agentVersion, channel: r.updateChannel ?? 'legacy', trustRootVersion: r.trustRootVersion, targetsVersion: r.targetsVersion,
      reportedAt: r.trustReportedAt, lastSeenAt: r.lastSeenAt, online: r.isOnline,
    });
    return { counts, currentRootVersion: rootV, legacy: legacy.slice(0, 500).map(shape), behindRoot: behind.slice(0, 500).map(shape) };
  }
}

function dottedVersion(v: string): boolean {
  const parts = v.split('.');
  return parts.length >= 2 && parts.length <= 4 && parts.every((p) => /^[0-9]{1,6}$/.test(p));
}

function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
