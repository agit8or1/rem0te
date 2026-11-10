import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ActorContext } from '../rbac/access-control.service';
import { isOwnerRole } from '../rbac/capabilities';
import { PLATFORM_PERM } from '../rbac/platform-permissions';
import { UpdateTrustService } from '../update-trust/update-trust.service';
import { loadTrust } from '../integration/peers';
import { ControlsStore } from './controls.store';
import { SECURITY_FEATURES, type SecurityFeature } from './security-features';

/**
 * The Security Features view (v0.25): the static catalog plus, where the
 * backend can actually observe it, the effective state.
 *
 * Who sees what:
 *   - Platform Admin: platform scope, or any business.
 *   - `technicians:manage` (not in a technician context): the same, read-only
 *     — this mirrors GET /security-controls/policy, which they can already read.
 *   - Business Owner (own account context): their own business only.
 *   - Everyone else, including every technician context: 403. The catalog
 *     text is public in the repository; the effective state is configuration.
 *
 * `effective` is null whenever nothing the server holds can say what is true,
 * and the UI renders that as "Unknown". It is never inferred from a default,
 * and never claims an endpoint did something on the strength of a portal
 * setting: `source` names where the value came from.
 */
export type EffectiveSource = 'code' | 'portal-policy' | 'endpoint-reports' | 'mirror' | 'server-config';
export interface Effective { state: string; detail?: string; source: EffectiveSource }
export type ScopedFeature = SecurityFeature & { effective: Effective | null };

@Injectable()
export class SecurityFeaturesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly controls: ControlsStore,
    private readonly updateTrust: UpdateTrustService,
  ) {}

  /** Throws unless the actor may see this scope. Returns the business id to scope to (null = platform). */
  private authorize(actor: ActorContext, businessId?: string): string | null {
    if (actor.technician) throw new ForbiddenException('Switch back to your own account context to view security configuration');
    if (actor.isPlatformAdmin) return businessId || null;
    if ((actor.platformPermissions ?? []).includes(PLATFORM_PERM.TECHNICIANS_MANAGE)) return businessId || null;
    if (actor.businessId && isOwnerRole(actor.roleType)) {
      if (businessId && businessId !== actor.businessId) throw new ForbiddenException('Only your own business');
      return actor.businessId;
    }
    throw new ForbiddenException('Security configuration is visible to Platform Admins, technician managers and Business Owners');
  }

  async catalog(actor: ActorContext, requestedBusinessId?: string) {
    const businessId = this.authorize(actor, requestedBusinessId);
    let business: { id: string; name: string } | null = null;
    if (businessId) {
      business = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { id: true, name: true } });
      if (!business) throw new NotFoundException('Business not found');
    }
    const eff = await this.effectiveStates(businessId);
    const features: ScopedFeature[] = SECURITY_FEATURES.map((f) => ({ ...f, effective: eff[f.id] ?? null }));
    return { scope: business ? { kind: 'business' as const, business } : { kind: 'platform' as const }, features };
  }

  private async effectiveStates(businessId: string | null): Promise<Record<string, Effective>> {
    const out: Record<string, Effective> = {};
    const c = await this.controls.effective(businessId);
    const where = businessId ? 'this business (stricter of platform and business)' : 'platform';

    // Always-on server checks: the code is the state. There is no switch.
    for (const id of ['business-isolation', 'enrollment-binding', 'computer-scope', 'presets', 'pairwise-scope', 'self-promotion',
      'launch-authorization', 'credential-audit', 'replay-protection', 'trust-review']) {
      out[id] = { state: 'Always on', detail: 'Server-side check with no setting to turn it off.', source: 'code' };
    }

    // What the portal will allow at launch. This is policy, not what the
    // endpoint does — the endpoint rows below are counted separately.
    out['attended-consent'] = {
      state: c.attendedConsent === 'required' ? 'Required for preset launches' : 'Not required',
      detail: `Portal policy for ${where}. Members, custom assignments and Platform Admins are never asked: computers installed by Rem0te accept the permanent password.`,
      source: 'portal-policy',
    };
    out['unattended'] = {
      state: c.unattendedAccess === 'off' ? 'Explicit unattended launches refused' : 'May be requested',
      detail: `Portal policy for ${where}. An ordinary Connect by a member or admin is unattended in effect.`,
      source: 'portal-policy',
    };
    // Clipboard and file transfer: the policy value is not transmitted
    // anywhere, and nothing reports what a session allowed. Unknown is the
    // truthful answer — deliberately left without an entry.
    out['session-length'] = { state: 'Not enforced', detail: `Policy value ${c.maxSessionMinutes} min for ${where} is shown at launch only.`, source: 'code' };
    out['protected-classes'] = { state: c.protectedClasses.join(', '), detail: `Protected classes for ${where}.`, source: 'portal-policy' };
    out['fleet-abuse'] = {
      state: `${c.windowMinutes}-minute window`,
      detail: (['L1', 'L2', 'L3', 'member', 'platformAdmin', 'integration'] as const)
        .map((k) => `${k}: ${c.thresholds[k].devices} devices / ${c.thresholds[k].launches} launches / ${c.thresholds[k].writes} writes`).join('; '),
      source: 'portal-policy',
    };

    // Endpoint-side enforcement: only what endpoints have reported. A count of
    // zero is an observation ("none reported"), not an unknown.
    const scope = businessId ? { customerId: businessId } : {};
    const [total, reporting] = await Promise.all([
      this.prisma.endpoint.count({ where: { ...scope, status: 'ACTIVE' } }),
      this.prisma.endpoint.count({ where: { ...scope, status: 'ACTIVE', sessionEnforcement: { not: Prisma.AnyNull } } }),
    ]);
    const enforcement = { state: reporting ? `${reporting} of ${total} computers report it` : `No computer reports it (0 of ${total})`, detail: 'Endpoint.sessionEnforcement, as reported by agents. Without a report the launch is refused.', source: 'endpoint-reports' as const };
    out['view-only'] = enforcement;
    out['input-control'] = { ...enforcement, detail: 'Control needs an activated temporary grant and, when consent is required, an endpoint that reports consent enforcement.' };

    // Session evidence: what the last 30 days actually produced, by how it
    // was established. Counted, not inferred.
    const since = new Date(Date.now() - 30 * 86400_000);
    const sWhere = { ...(businessId ? { customerId: businessId } : {}), createdAt: { gte: since } };
    const [launched, measured, confirmed, unknown] = await Promise.all([
      this.prisma.supportSession.count({ where: sWhere }),
      this.prisma.supportSession.count({ where: { ...sWhere, timingQuality: 'MEASURED' } }),
      this.prisma.supportSession.count({ where: { ...sWhere, connectionConfirmedAt: { not: null } } }),
      this.prisma.supportSession.count({ where: { ...sWhere, status: 'STATUS_UNKNOWN' } }),
    ]);
    out['session-evidence'] = {
      state: launched ? `${confirmed} of ${launched} launches confirmed, ${measured} measured` : 'No launches in 30 days',
      detail: `Last 30 days, ${where}. ${unknown} ended as Status unknown. Confirmed = the endpoint agent or the technician reported a connection.`,
      source: 'endpoint-reports',
    };

    // Signed updates: the mode is portal configuration; the repository is what the mirror serves.
    const mode = await this.updateTrust.mode();
    const served = this.updateTrust.status();
    out['release-signing'] = {
      state: `${mode.mode === 'signed_only' ? 'Signed only' : 'Legacy allowed'}${mode.mode === 'signed_only' ? ` · portal migration ${mode.legacyPortalMigration ? 'on' : 'off'}` : ''}`,
      detail: served.configured ? `Repository served: root v${served.roles?.root.version}, targets v${served.roles?.targets.version}. Not verified by the portal — agents verify.` : `No signed repository is served (${served.reason ?? 'not configured'}).`,
      source: 'mirror',
    };

    // The integration: configured is a server-file fact; a broken file is reported, not hidden.
    let trust: ReturnType<typeof loadTrust> = null; let broken = false;
    try { trust = loadTrust(); } catch { broken = true; }
    out['integration'] = broken
      ? { state: 'Misconfigured', detail: 'INTEGRATION_PEERS_FILE is set but does not load.', source: 'server-config' }
      : { state: trust ? 'Configured (read-only analysis)' : 'Not configured', detail: trust ? 'Peers file loaded. Jobs collect bounded evidence only; nothing executes on a computer.' : 'INTEGRATION_PEERS_FILE is not set.', source: 'server-config' };

    // Approved actions: whether a signer is configured is server config;
    // support and outcomes are what agents and jobs actually recorded.
    const aScope = businessId ? { customerId: businessId } : {};
    const [supporting, jobs] = await Promise.all([
      this.prisma.endpoint.count({ where: { ...aScope, status: 'ACTIVE', agentActions: { has: 'windows.service.start@1' } } }),
      this.prisma.actionJob.groupBy({ by: ['status'], where: { ...aScope, createdAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const signer = !!process.env.APPROVAL_SIGNER_INTERNAL_URL;
    const counts = jobs.map((g) => `${g._count._all} ${g.status.toLowerCase().replace(/_/g, ' ')}`).join(', ');
    out['approved-actions'] = {
      state: signer ? `Signer configured · ${supporting} of ${total} computers support it` : 'No approval signer configured',
      detail: `Last 30 days, ${where}: ${counts || 'no requests'}. Support is what signed agents report; whether a given plan runs is decided on the computer.`,
      source: 'endpoint-reports',
    };

    // Not built: the code is the state.
    for (const id of ['elevation', 'remote-shell', 'chat', 'scripts-fixes', 'mdm', 'backup-recovery']) {
      out[id] = { state: 'Not available in this build', source: 'code' };
    }
    return out;
  }
}
