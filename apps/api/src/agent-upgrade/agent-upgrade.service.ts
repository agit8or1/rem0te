import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AccessControlService, type ActorContext } from '../rbac/access-control.service';
import { CAP } from '../rbac/capabilities';
import { EndpointsService } from '../endpoints/endpoints.service';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { AgentMigrationService } from '../update-trust/agent-migration.service';
import { isWindows, migrationState, MIGRATION_STATES, type MigrationState } from '../update-trust/agent-migration';
import { ContainmentService } from '../containment/containment.service';
import { pauseMessage } from '../containment/pause';
import { PublicUrlService } from '../platform/public-url.service';
import { ControlsStore } from '../security-controls/controls.store';
import { AccessPolicyService } from '../security-controls/access-policy.service';
import { assertFresh } from '../security-controls/review';
import { readOnlyAgentOs } from '../common/platform';
import { agentMeetsContract, AGENT_CONTRACT_VERSION } from '../common/agent-contract';
import { refusalOf, type BulkResult } from '../device-views/rules';

export type AgentKind = 'standard' | 'signed' | 'linux' | 'macos' | 'rustdesk-only' | 'unknown';

type BulkTarget = { id: string; name: string; customerId: string | null };

/**
 * The Agent card on the device workspace (0.34), and the two things it can
 * ask for: update the agent the computer already runs, and move a standard
 * Windows agent onto the signed agent.
 *
 *   Update agent (standard Windows): the existing reinstall path —
 *     EndpointsService.requestAgentReinstall, with its capability
 *     (computers:edit), fleet-abuse admission, device-secret refusal and
 *     audit (ENDPOINT_AGENT_REINSTALL_REQUESTED). It re-runs the current
 *     standard installer, which keeps the enrolment, the device secret and
 *     the RustDesk configuration and password.
 *   Check for update now (signed): the same flag; a signed agent answers it
 *     with `rem0te-agent.exe update`, which installs only what the signed
 *     repository lists. Nothing the portal sends is code.
 *   Linux / macOS: nothing to queue — those agents act on nothing the server
 *     sends — so the card gives the exact command to re-run on the computer.
 *   Upgrade to signed agent: AgentMigrationService, with a fresh sign-in and a
 *     reason. Why that is enough, and where it is refused, is in
 *     update-trust/agent-migration.ts.
 *
 * Every read starts from the computer's own scope check (another business's
 * computer is a 404), and the migration status list from
 * acl.endpointVisibilityWhere.
 */
@Injectable()
export class AgentUpgradeService {
  private readonly logger = new Logger('AgentUpgrade');

  constructor(
    private readonly prisma: PrismaService,
    private readonly acl: AccessControlService,
    private readonly endpoints: EndpointsService,
    private readonly updateTrust: UpdateTrustService,
    private readonly migration: AgentMigrationService,
    private readonly containment: ContainmentService,
    private readonly urls: PublicUrlService,
    private readonly controls: ControlsStore,
    private readonly policy: AccessPolicyService,
  ) {}

  private platformVersion(): string {
    try {
      const file = process.env.VERSION_FILE ?? path.join(process.env.PROJECT_ROOT ?? process.cwd(), 'version.json');
      return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: string }).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** The command that re-runs a Linux or macOS installer on the computer itself. It keeps the device secret. */
  installerCommand(os: 'Linux' | 'macOS'): string {
    const base = this.urls.api().replace(/\/+$/, '');
    return `curl -fsSL ${base}/api/v1/public/install/${os === 'Linux' ? 'linux' : 'macos'}.sh | sudo bash`;
  }

  private kindOf(ep: { platform: string | null; updateChannel: string | null; agentVersion: string | null }): AgentKind {
    const os = readOnlyAgentOs(ep.platform);
    if (os) return ep.agentVersion ? (os === 'Linux' ? 'linux' : 'macos') : 'rustdesk-only';
    if (ep.updateChannel === 'signed') return 'signed';
    if (ep.agentVersion) return 'standard';
    return isWindows(ep.platform) ? 'standard' : 'unknown';
  }

  // ── The Agent card ───────────────────────────────────────────────────────

  async card(actor: ActorContext, id: string) {
    await this.acl.assertEndpointInScope(actor, id, CAP.COMPUTERS_VIEW);
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const ep = (await this.prisma.endpoint.findUnique({
      where: { id },
      select: {
        platform: true, agentVersion: true, updateChannel: true, trustRootVersion: true, targetsVersion: true, trustReportedAt: true,
        agentSha256: true, agentUpdateCheckedAt: true, agentUpdateResult: true, status: true, customerId: true,
        rustdeskNode: { select: { agentSecretHash: true, reinstallRequestedAt: true, reinstallDispatchedAt: true } },
      },
    }))!;
    const kind = this.kindOf(ep);
    const served = this.updateTrust.agentTarget();
    const mode = await this.updateTrust.mode();
    const pause = await this.containment.blocking('updates', ep.customerId);
    const pauseText = pause ? pauseMessage(pause, 'updates') : null;
    const server = this.platformVersion();
    const os = readOnlyAgentOs(ep.platform);
    const hasSecret = !!ep.rustdeskNode?.agentSecretHash;

    // Is the version current? Against what this agent type updates FROM.
    let current: { state: 'current' | 'behind' | 'unknown'; text: string };
    if (kind === 'signed') {
      current = !served ? { state: 'unknown', text: 'No signed release is published to compare against.' }
        : !ep.agentSha256 ? { state: 'unknown', text: 'The agent has not reported which build it runs.' }
          : ep.agentSha256 === served.sha256 ? { state: 'current', text: 'Runs the signed build the repository publishes.' }
            : { state: 'behind', text: 'Not the signed build the repository publishes. It updates itself at a check-in; Check now asks it to.' };
    } else if (kind === 'rustdesk-only' || !ep.agentVersion) {
      current = { state: 'unknown', text: kind === 'rustdesk-only' ? 'RustDesk only: no Rem0te agent reports a version.' : 'The agent has not reported a version.' };
    } else if (ep.agentVersion === server) {
      current = { state: 'current', text: `Matches this portal (${server}).` };
    } else {
      current = {
        state: 'behind',
        text: `This portal serves ${server}.${agentMeetsContract(ep.agentVersion) ? '' : ` It is also older than ${AGENT_CONTRACT_VERSION}, the last release that changed what the agent must do.`}`,
      };
    }

    // Update agent / Check for update now / re-run the installer.
    const reinstall = { pending: !!ep.rustdeskNode?.reinstallRequestedAt, dispatched: !!ep.rustdeskNode?.reinstallDispatchedAt };
    let update: { possible: boolean; label: string; reason: string | null; command?: string };
    if (os) {
      update = { possible: false, label: 'Re-run the installer', reason: `The ${os} agent acts on nothing the server sends, so it cannot be updated from here. Re-run the installer on the computer; it keeps the enrolment.`, command: this.installerCommand(os) };
    } else if (kind === 'unknown') {
      update = { possible: false, label: 'Update agent', reason: 'This computer has not reported an agent the console can update.' };
    } else {
      const label = kind === 'signed' ? 'Check for update now' : 'Update agent';
      const why = ep.status === 'ARCHIVED' ? 'Archived: nothing is sent to an archived computer.'
        : !hasSecret ? 'This computer has never authenticated with a device secret. Re-run the installer on it once.'
          : pauseText ? pauseText
            : kind === 'standard' && mode.mode === 'signed_only' && !mode.legacyPortalMigration ? 'This portal is in Signed only, which hands standard agents nothing to run. Upgrade it to the signed agent instead (locally or through GPO/Intune in this mode).'
              : null;
      update = { possible: !why, label, reason: why };
    }

    // Upgrade to signed agent: only where it means something.
    const latest = await this.migration.latestFor(id);
    let migration: null | {
      possible: boolean; code: string | null; reason: string | null; fix: string | null; link: { href: string; label: string } | null;
      request: null | { id: string; state: MigrationState; text: string; requestedAt: Date; dispatchedAt: Date | null; fetchedAt: Date | null; completedAt: Date | null; cancelledAt: Date | null; reason: string };
    } = null;
    if (isWindows(ep.platform) && (kind !== 'signed' || latest)) {
      const b = kind === 'signed' ? null : await this.migration.block(id);
      const st = latest ? migrationState(latest) : null;
      migration = {
        possible: kind !== 'signed' && !b && !(st && ['pending', 'held', 'dispatched', 'downloaded', 'not_confirmed'].includes(st.state)),
        code: b?.code ?? null, reason: b?.reason ?? null, fix: b?.fix ?? null, link: b?.link ?? null,
        request: latest && st ? {
          id: latest.id, state: st.state, text: st.text, requestedAt: latest.requestedAt, dispatchedAt: latest.dispatchedAt,
          fetchedAt: latest.fetchedAt, completedAt: latest.completedAt, cancelledAt: latest.cancelledAt, reason: latest.reason,
        } : null,
      };
    }

    return {
      kind,
      platform: ep.platform,
      version: ep.agentVersion,
      server,
      current,
      channel: kind === 'signed' ? 'signed' : isWindows(ep.platform) ? 'standard' : null,
      signed: kind === 'signed' ? { trustRootVersion: ep.trustRootVersion, targetsVersion: ep.targetsVersion, reportedAt: ep.trustReportedAt, sha256: ep.agentSha256 } : null,
      lastUpdate: ep.agentUpdateCheckedAt ? { checkedAt: ep.agentUpdateCheckedAt, result: ep.agentUpdateResult } : null,
      portal: {
        mode: mode.mode, legacyPortalMigration: mode.legacyPortalMigration,
        modeLabel: mode.mode === 'legacy_allowed' ? 'Legacy allowed' : mode.legacyPortalMigration ? 'Signed only + portal migration' : 'Signed only',
        repository: this.updateTrust.isConfigured(), signedAgentSha256: served?.sha256 ?? null,
      },
      updatesPaused: pauseText,
      reinstall,
      update,
      migration,
    };
  }

  // ── Update agent ─────────────────────────────────────────────────────────

  /**
   * The existing reinstall, with the refusals that would otherwise look
   * accepted and never happen said up front: a read-only agent (with the
   * command to run instead), an updates pause, and Signed only for a standard
   * agent (the heartbeat withholds the flag there).
   */
  async updateAgent(actor: ActorContext, id: string) {
    await this.acl.assertEndpointInScope(actor, id, CAP.COMPUTERS_EDIT);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    const ep = (await this.prisma.endpoint.findUnique({ where: { id }, select: { platform: true, updateChannel: true, agentVersion: true, customerId: true } }))!;
    const os = readOnlyAgentOs(ep.platform);
    if (os) {
      throw new BadRequestException({
        code: os === 'Linux' ? 'LINUX_AGENT_READ_ONLY' : 'MACOS_AGENT_READ_ONLY',
        message: `The ${os} agent acts on nothing the server sends. Re-run the installer on the computer: ${this.installerCommand(os)}`,
      });
    }
    await this.containment.assertOpen('updates', ep.customerId);
    const kind = this.kindOf(ep);
    if (kind === 'standard') {
      const mode = await this.updateTrust.mode();
      if (mode.mode === 'signed_only' && !mode.legacyPortalMigration) {
        throw new ConflictException({ code: 'SIGNED_ONLY', message: 'This portal is in Signed only, which hands standard agents nothing to run, so a reinstall would never be delivered. Upgrade it to the signed agent locally or through GPO/Intune.' });
      }
    }
    const r = await this.endpoints.requestAgentReinstall(actor, id);
    return { ...r, kind, what: kind === 'signed' ? 'check' : 'reinstall' };
  }

  // ── Upgrade to signed agent ──────────────────────────────────────────────

  async migrate(actor: ActorContext, id: string, reason: unknown, freshMethod: string | null, via: 'single' | 'bulk' = 'single') {
    await this.acl.assertEndpointInScope(actor, id, CAP.COMPUTERS_EDIT);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    assertFresh(freshMethod, { action: 'agent.migrate', message: 'Upgrading a computer to the signed agent runs a portal-served script on it once: confirm it is you.' });
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
    const why = typeof reason === 'string' ? reason.replace(/[\x00-\x1f\x7f]/g, ' ').trim() : '';
    if (why.length < 3 || why.length > 400) throw new BadRequestException({ code: 'REASON_REQUIRED', message: 'Give a reason of 3 to 400 characters; it is recorded in the audit log.' });
    // The preconditions first, so a refusal costs nothing against the fleet limit.
    const b = await this.migration.block(id);
    if (b) throw new ConflictException({ code: b.code, message: b.reason });
    await this.endpoints.admitWrite(actor, id);
    const out = await this.migration.request(actor, id, why, via);
    const st = migrationState(out.request);
    return { id: out.request.id, state: st.state, text: st.text, unchanged: out.unchanged };
  }

  async cancelMigration(actor: ActorContext, id: string) {
    await this.acl.assertEndpointInScope(actor, id, CAP.COMPUTERS_EDIT);
    this.acl.assertCapability(actor, CAP.COMPUTERS_EDIT);
    return this.migration.cancel(actor, id);
  }

  // ── Migration status (the fleet view) ────────────────────────────────────

  /**
   * Requests on computers this person can see: every open one, and those
   * finished in the last 30 days. Filtered by state after it is computed, so
   * "not confirmed" means exactly what the card says.
   */
  async migrations(actor: ActorContext, q: { state?: string; businessId?: string }) {
    this.acl.assertCapability(actor, CAP.COMPUTERS_VIEW);
    const state = q.state && (MIGRATION_STATES as string[]).includes(q.state) ? (q.state as MigrationState) : null;
    if (q.state && !state && q.state !== 'open' && q.state !== 'all') throw new BadRequestException({ code: 'INVALID_REQUEST', message: `state must be one of open, all, ${MIGRATION_STATES.join(', ')}` });
    const since = new Date(Date.now() - 30 * 86400_000);
    const rows = await this.prisma.agentMigration.findMany({
      where: {
        AND: [
          { endpoint: this.acl.endpointVisibilityWhere(actor, q.businessId ?? null) },
          { OR: [{ completedAt: null, cancelledAt: null }, { completedAt: { gte: since } }, { cancelledAt: { gte: since } }] },
        ],
      },
      orderBy: { requestedAt: 'desc' },
      take: 1000,
      select: {
        id: true, endpointId: true, reason: true, requestedAt: true, dispatchedAt: true, lastDispatchedAt: true, dispatchCount: true, fetchedAt: true,
        holdReason: true, holdAt: true, completedAt: true, cancelledAt: true,
        endpoint: { select: { name: true, hostname: true, isOnline: true, lastSeenAt: true, agentVersion: true, updateChannel: true, agentUpdateCheckedAt: true, agentUpdateResult: true, customer: { select: { id: true, name: true } } } },
      },
    });
    const counts = Object.fromEntries(MIGRATION_STATES.map((s) => [s, 0])) as Record<MigrationState, number>;
    const shaped = rows.map((r) => {
      const st = migrationState(r);
      counts[st.state]++;
      return {
        id: r.id, endpointId: r.endpointId, name: r.endpoint.hostname ?? r.endpoint.name, business: r.endpoint.customer,
        online: r.endpoint.isOnline, lastSeenAt: r.endpoint.lastSeenAt, agentVersion: r.endpoint.agentVersion, channel: r.endpoint.updateChannel === 'signed' ? 'signed' : 'standard',
        lastUpdate: r.endpoint.agentUpdateCheckedAt ? { checkedAt: r.endpoint.agentUpdateCheckedAt, result: r.endpoint.agentUpdateResult } : null,
        state: st.state, text: st.text, reason: r.reason, requestedAt: r.requestedAt, dispatchedAt: r.dispatchedAt, dispatchCount: r.dispatchCount,
        fetchedAt: r.fetchedAt, completedAt: r.completedAt, cancelledAt: r.cancelledAt,
      };
    });
    const open = (s: MigrationState) => s !== 'completed' && s !== 'cancelled';
    const filtered = state ? shaped.filter((r) => r.state === state) : q.state === 'all' ? shaped : shaped.filter((r) => open(r.state));
    return { counts, rows: filtered.slice(0, 500), total: filtered.length };
  }

  // ── Bulk (0.33 bulk-actions path) ────────────────────────────────────────

  /**
   * agent.update and agent.migrate for the device list's selection. Each
   * computer goes through the single route's own method, so scope,
   * capability, preconditions, admission and audit are the single route's.
   * Fresh authentication is asked once for the request (agent.migrate), and
   * the request stops short of the person's fleet limit instead of tripping
   * it, and stops entirely once the person is paused.
   */
  async bulk(a: ActorContext, action: 'agent.update' | 'agent.migrate', targets: BulkTarget[], results: Map<string, BulkResult>, opts: { reason?: string; freshMethod: string | null }) {
    if (action === 'agent.migrate') {
      assertFresh(opts.freshMethod, { action: 'agent.migrate', message: 'Upgrading computers to the signed agent runs a portal-served script on each once: confirm it is you.' });
    }
    const identity = `user:${a.userId}`;
    const controls = await this.controls.platform();
    const sinceW = new Date(Date.now() - controls.windowMinutes * 60_000);
    const now = new Date();
    const [recent, exceptions] = await Promise.all([
      this.prisma.privilegedActivity.findMany({ where: { identity, at: { gte: sinceW } }, select: { endpointId: true, customerId: true, kind: true } }),
      this.prisma.maintenanceException.findMany({
        where: { identity, status: 'APPROVED', kinds: { has: 'WRITE' }, startsAt: { lte: now }, expiresAt: { gt: now } },
        select: { endpointIds: true },
      }),
    ]);
    const devices = new Set(recent.map((r) => r.endpointId).filter((x): x is string => !!x));
    const businesses = new Set(recent.map((r) => r.customerId).filter((x): x is string => !!x));
    let writes = recent.filter((r) => r.kind === 'WRITE').length;
    const exempt = new Set(exceptions.flatMap((e) => e.endpointIds));
    let stopped: { code: string; reason: string } | null = null;
    for (const t of targets) {
      const base = { endpointId: t.id, name: t.name };
      if (stopped) { results.set(t.id, { ...base, ok: false, ...stopped }); continue; }
      try {
        // Refusals that cost nothing are decided before the budget.
        if (action === 'agent.migrate') {
          const b = await this.migration.block(t.id);
          if (b) { results.set(t.id, { ...base, ok: false, code: b.code, reason: b.reason }); continue; }
          if (await this.migration.openFor(t.id)) { results.set(t.id, { ...base, ok: true, unchanged: true, reason: 'Already requested.' }); continue; }
        }
        if (!exempt.has(t.id)) {
          const limits = controls.thresholds[this.policy.tierFor(a, t.id)];
          const over = !devices.has(t.id) && devices.size + 1 > limits.devices ? `devices ${devices.size + 1} > ${limits.devices}`
            : t.customerId && !businesses.has(t.customerId) && businesses.size + 1 > limits.businesses ? `businesses ${businesses.size + 1} > ${limits.businesses}`
              : writes + 1 > limits.writes ? `writes ${writes + 1} > ${limits.writes}` : null;
          if (over) {
            results.set(t.id, { ...base, ok: false, code: 'FLEET_LIMIT', reason: `Not sent: it would pass your limit in ${controls.windowMinutes} minutes (${over}). Try the rest later, or ask for a maintenance exception.` });
            continue;
          }
        }
        const r = action === 'agent.update'
          ? await this.updateAgent(a, t.id)
          : await this.migrate(a, t.id, opts.reason, opts.freshMethod, 'bulk');
        devices.add(t.id); if (t.customerId) businesses.add(t.customerId); writes++;
        results.set(t.id, { ...base, ok: true, ...('unchanged' in r && r.unchanged ? { unchanged: true } : {}) });
      } catch (e) {
        const r = refusalOf(e);
        if (r.code === 'ERROR') this.logger.warn(`bulk ${action} ${t.id}: ${String(e)}`);
        results.set(t.id, { ...base, ok: false, ...r });
        if (r.code === 'IDENTITY_PAUSED' || r.code === 'THRESHOLD_TRIPPED') stopped = { code: 'IDENTITY_PAUSED', reason: 'Not attempted: privileged work for you is paused until an administrator clears it.' };
      }
    }
  }
}

