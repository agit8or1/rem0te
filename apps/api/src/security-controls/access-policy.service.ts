import { Injectable } from '@nestjs/common';
import type { DeviceClass } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { ActorContext } from '../rbac/access-control.service';
import type { TechnicianGrantSource } from '../rbac/technician-access.service';
import { ActorResolverService } from '../rbac/actor-resolver.service';
import { CAP, effectiveCapabilities, isOwnerRole, type Capability } from '../rbac/capabilities';
import { AbuseGuardService, type ThresholdKey } from './abuse-guard.service';
import { ControlsStore } from './controls.store';
import { BUILT_IN_PRESETS, PresetPolicy, presetCapabilities, type AccessControls } from './presets';

export type LaunchMode = 'view_only' | 'control' | 'elevated' | 'unattended';
export interface LaunchContext { via: 'browser' | 'launcher'; technicianDeviceId?: string | null }

/** What an endpoint reports it can enforce itself. Unknown = nothing. */
export interface SessionEnforcement { viewOnly?: boolean; attendedConsent?: boolean; clipboardOff?: boolean; fileTransferOff?: boolean; reportedAt?: string }

export type LaunchDecision =
  | { ok: true; path: 'member' | 'legacy_assignment' | 'preset'; revealCredential: boolean; maxSessionMinutes: number | null; tier: ThresholdKey }
  | { ok: false; reason: string; message: string; status: 'denied' | 'unavailable' | 'requires_request' };

type EndpointForLaunch = { id: string; customerId: string | null; deviceClass: DeviceClass; sessionEnforcement: unknown; accessMode: string };

/**
 * The launch policy, applied on top of the existing connect decision
 * (EndpointsService.authorizeConnect), so every way of starting a session —
 * POST /connect, connect.cmd, a connection-grant redemption, a launcher token
 * at issue and at redemption — gets it from one place.
 *
 * Order, and why:
 *   1. a paused identity gets nothing;
 *   2. protected device classes are default-deny for EVERYONE, Platform Admin
 *      included, unless an independently approved, activated exception exists
 *      AND the launch comes from a managed admin workstation;
 *   3. a technician acting through a PRESET never gets a standing session:
 *      control needs an activated temporary grant, and every restriction the
 *      mode depends on (view-only, attended consent) must be enforceable at
 *      the endpoint or the launch is refused — never quietly opened with more;
 *   4. custom assignments (pre-0.23) and business members keep the behaviour
 *      they had: nothing is inferred from computers:connect / computers:edit.
 */
@Injectable()
export class AccessPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly controls: ControlsStore,
    private readonly abuse: AbuseGuardService,
    private readonly actors: ActorResolverService,
  ) {}

  /** Which threshold row applies to this actor on this computer. */
  tierFor(actor: ActorContext, endpointId: string | null): ThresholdKey {
    if (actor.technician) {
      const covering = this.covering(actor.technician.sources, endpointId);
      if (covering.some((s) => !s.presetId)) return 'custom';
      const tiers = covering.map((s) => s.presetTier).filter(Boolean) as string[];
      return (tiers.sort().pop() as ThresholdKey) ?? 'L1';
    }
    if (actor.isPlatformAdmin) return 'platformAdmin';
    return 'member';
  }

  private covering(sources: TechnicianGrantSource[], endpointId: string | null) {
    return sources.filter((s) => endpointId === null || s.endpointIds === null || s.endpointIds.includes(endpointId));
  }

  /** Does the technician hold `capability` through a CUSTOM grant on this computer? */
  private legacyCustom(actor: ActorContext, cap: Capability, endpointId: string) {
    return !!actor.technician && this.covering(actor.technician.sources, endpointId).some((s) => !s.presetId && (s.capabilities as string[]).includes(cap));
  }

  async evaluateLaunch(actor: ActorContext, ep: EndpointForLaunch, mode: LaunchMode, ctx: LaunchContext): Promise<LaunchDecision> {
    const controls = await this.controls.effective(ep.customerId);
    const tier = this.tierFor(actor, ep.id);

    if (await this.abuse.isPaused(`user:${actor.userId}`)) {
      return { ok: false, status: 'denied', reason: 'identity_paused', message: 'Your privileged access is paused after an activity limit was reached. An administrator has been alerted and must clear it.' };
    }

    const managedWorkstation = ctx.via === 'launcher' && ctx.technicianDeviceId
      ? !!(await this.prisma.technicianDevice.findFirst({ where: { id: ctx.technicianDeviceId, userId: actor.userId, isActive: true, isManagedAdminWorkstation: true }, select: { id: true } }))
      : false;

    if (controls.trustedWorkstations === 'required_for_all' && !managedWorkstation) {
      return { ok: false, status: 'denied', reason: 'trusted_workstation_required', message: 'Policy requires every session to start from a managed admin workstation through the launcher.' };
    }

    if ((controls.protectedClasses as string[]).includes(ep.deviceClass)) {
      const exception = await this.activeTemporary(actor.userId, ep.id, 'PROTECTED_EXCEPTION');
      if (!exception) {
        return { ok: false, status: 'requires_request', reason: 'protected_device_class', message: `This computer is a protected ${ep.deviceClass.replace(/_/g, ' ').toLowerCase()}. Interactive access needs an independently approved exception, activated with fresh authentication, from a managed admin workstation.` };
      }
      if (!managedWorkstation) {
        return { ok: false, status: 'denied', reason: 'protected_requires_managed_workstation', message: 'Your exception is active, but protected computers can only be reached from a managed admin workstation through the launcher.' };
      }
    }

    if (mode === 'unattended' && controls.unattendedAccess === 'off') {
      return { ok: false, status: 'denied', reason: 'unattended_off', message: 'Unattended access is off by policy.' };
    }

    // Business members and Platform Admins: the existing connect decision
    // already ran; nothing new is granted or inferred here.
    if (!actor.technician) {
      return { ok: true, path: 'member', revealCredential: true, maxSessionMinutes: null, tier };
    }

    // Pre-0.23 custom assignments keep exactly what they had.
    if (mode === 'control' && this.legacyCustom(actor, CAP.COMPUTERS_CONNECT, ep.id)) {
      return { ok: true, path: 'legacy_assignment', revealCredential: true, maxSessionMinutes: null, tier };
    }

    const presets = this.covering(actor.technician.sources, ep.id).filter((s) => s.presetPolicy);
    if (presets.length === 0) return { ok: false, status: 'denied', reason: 'outside_technician_assignment', message: 'No active assignment covers this computer.' };
    const enforce = (ep.sessionEnforcement ?? {}) as SessionEnforcement;
    const maxMin = Math.min(controls.maxSessionMinutes, ...presets.map((s) => s.presetPolicy!.maxSessionMinutes));

    if (mode === 'view_only') {
      const eligible = presets.filter((s) => s.presetPolicy!.remoteViewOnly === 'allowed' && (!s.presetPolicy!.standardWorkstationsOnly || ep.deviceClass === 'WORKSTATION'));
      if (!eligible.length) return { ok: false, status: 'denied', reason: 'view_only_not_granted', message: 'Your access level does not include view-only sessions on this computer.' };
      if (enforce.viewOnly !== true) {
        return { ok: false, status: 'unavailable', reason: 'endpoint_cannot_enforce_view_only', message: 'This computer cannot enforce a view-only session (its agent does not report an enforceable view-only mode). The launch was blocked rather than opened with control.' };
      }
      if (controls.attendedConsent === 'required' && enforce.attendedConsent !== true) {
        return { ok: false, status: 'unavailable', reason: 'endpoint_cannot_enforce_consent', message: 'Customer consent is required, and this computer cannot enforce it (it accepts a permanent password). The launch was blocked.' };
      }
      return { ok: true, path: 'preset', revealCredential: false, maxSessionMinutes: maxMin, tier };
    }

    if (mode === 'elevated') {
      return { ok: false, status: 'unavailable', reason: 'elevation_unavailable', message: 'Elevated sessions are unavailable: there is no privileged helper on the endpoint to enforce them.' };
    }

    // Interactive control.
    if (presets.some((s) => s.presetPolicy!.remoteControl === 'off') && !presets.some((s) => s.presetPolicy!.remoteControl !== 'off')) {
      return { ok: false, status: 'denied', reason: 'control_not_granted', message: 'Your access level does not include interactive control.' };
    }
    if (!presets.some((s) => s.presetPolicy!.remoteControl === 'allowed')) {
      const grant = await this.activeTemporary(actor.userId, ep.id, 'CONTROL');
      if (!grant) return { ok: false, status: 'requires_request', reason: 'temporary_grant_required', message: 'Interactive control needs a temporary grant: request it, have it independently approved, then activate it with fresh authentication.' };
    }
    if (controls.attendedConsent === 'required' && enforce.attendedConsent !== true) {
      return { ok: false, status: 'unavailable', reason: 'endpoint_cannot_enforce_consent', message: 'Customer consent is required, and this computer cannot enforce it (it accepts a permanent password). The launch was blocked.' };
    }
    // Never hand a preset-backed technician the permanent password: it would
    // outlive the grant and allow a direct reconnect the portal never sees.
    return { ok: true, path: 'preset', revealCredential: false, maxSessionMinutes: maxMin, tier };
  }

  async activeTemporary(userId: string, endpointId: string, mode: 'CONTROL' | 'ELEVATION' | 'PROTECTED_EXCEPTION') {
    return this.prisma.temporaryAccessRequest.findFirst({
      where: { userId, endpointId, mode, status: 'APPROVED', activatedAt: { not: null }, expiresAt: { gt: new Date() } },
    });
  }

  // ── Inspector ─────────────────────────────────────────────────────────────

  static readonly ACTIONS = [
    'view_inventory', 'support_requests', 'event_logs', 'diagnostics', 'credential_reveal', 'enrollment',
    'launch_view_only', 'launch_control', 'launch_elevated', 'launch_unattended', 'clipboard', 'file_transfer',
    'scripts', 'patches', 'fix_request', 'fix_approval', 'fleet_execution', 'approve_requests',
  ] as const;

  /**
   * Effective access for one technician + business + (computer) + action, with
   * the reasons. Read-only: it builds the person's live actor exactly as a
   * request would and asks the same questions the enforcement points ask.
   */
  async inspect(userId: string, businessId: string, endpointId: string | null, action: (typeof AccessPolicyService.ACTIONS)[number]) {
    const business = await this.prisma.customer.findUnique({ where: { id: businessId }, select: { tenantId: true, name: true } });
    if (!business) return { decision: 'denied', reasons: ['business not found'] };
    const live = await this.actors.actorForBusiness(userId, business.tenantId, businessId);
    if (!live || live.businessId !== businessId) return { decision: 'denied', reasons: ['no current path into this business (no membership, no active assignment)'] };
    const caps = live.technician ? live.capabilities : effectiveCapabilities({ isPlatformAdmin: false, roleType: live.roleType, capabilities: live.capabilities });
    const actor: ActorContext = {
      userId, email: live.user.email, tenantId: business.tenantId, businessId, isPlatformAdmin: live.user.isPlatformAdmin,
      roleType: live.roleType, capabilities: caps as Capability[], technician: live.technician, ownBusinessId: live.ownBusinessId,
      assignedBusinessIds: live.assignedBusinessIds, platformPermissions: live.platformPermissions,
    };
    const ep = endpointId ? await this.prisma.endpoint.findUnique({ where: { id: endpointId }, select: { id: true, customerId: true, deviceClass: true, sessionEnforcement: true, accessMode: true, name: true } }) : null;
    if (endpointId && (!ep || ep.customerId !== businessId)) return { decision: 'denied', reasons: ['computer is not in this business'] };
    const sources = live.technician?.sources ?? [];
    const cover = this.covering(sources, endpointId);
    const via = live.technician
      ? cover.map((s) => ({ assignmentId: s.assignmentId, via: s.via, group: s.groupName, preset: s.presetTier ?? 'custom', capabilities: s.capabilities, computers: s.endpointIds ?? 'all' }))
      : [{ membership: isOwnerRole(live.roleType) ? 'Business Owner' : 'Business User', capabilities: caps }];
    const has = (c: Capability) => (live.technician ? cover.some((s) => (s.capabilities as string[]).includes(c)) : (caps as string[]).includes(c));
    const policyOf = (k: keyof PresetPolicy) => [...new Set(cover.filter((s) => s.presetPolicy).map((s) => String(s.presetPolicy![k])))];
    const paused = await this.abuse.isPaused(`user:${userId}`);

    const r = (decision: string, ...reasons: string[]) => ({ decision, reasons, grants: via, paused, tier: this.tierFor(actor, endpointId) });
    switch (action) {
      case 'view_inventory': return has(CAP.COMPUTERS_VIEW) ? r('allowed', 'computers:view from the grant(s) above') : r('denied', 'no grant covering this computer includes computers:view');
      case 'support_requests': return has(CAP.SUPPORT_REQUESTS) ? r('allowed') : r('denied', 'support:requests not granted');
      case 'event_logs': case 'diagnostics':
        return has(CAP.COMPUTERS_EVENT_LOGS) ? r('allowed', 'computers:event_logs on this computer, from the same grant') : r('denied', 'computers:event_logs not granted on this computer');
      case 'credential_reveal':
        if (live.technician && !cover.some((s) => !s.presetId && (s.capabilities as string[]).includes(CAP.COMPUTERS_EDIT))) return r('denied', 'presets never grant credential reveal');
        return has(CAP.COMPUTERS_EDIT) ? r('allowed', 'computers:edit (custom assignment or membership)') : r('denied');
      case 'enrollment': return has(CAP.COMPUTERS_ADD) && !cover.every((s) => s.presetId) ? r('allowed', 'computers:add') : r('denied', 'a tier never grants enrollment');
      case 'launch_view_only': case 'launch_control': case 'launch_elevated': case 'launch_unattended': {
        if (!ep) return r('denied', 'name a computer');
        const mode = ({ launch_view_only: 'view_only', launch_control: 'control', launch_elevated: 'elevated', launch_unattended: 'unattended' } as const)[action];
        if (!live.technician && !has(CAP.COMPUTERS_CONNECT)) return r('denied', 'computers:connect not held');
        const d = await this.evaluateLaunch(actor, ep, mode, { via: 'browser' });
        return d.ok ? r('allowed', `path: ${d.path}`, d.revealCredential ? 'permanent credential is revealed to the browser' : 'no credential revealed') : r(d.status, d.message);
      }
      case 'clipboard': case 'file_transfer': return r('unavailable', 'enforced on the technician\'s RustDesk client, not the endpoint; no per-session control exists');
      case 'scripts': case 'fleet_execution': return r('denied', 'locked off for every tier; no signed script catalog exists');
      case 'patches': return policyOf('patches').includes('request') ? r('unavailable', 'eligible to request, but patch installation is not implemented') : r('denied');
      case 'fix_request': return policyOf('fixRequests').some((v) => v !== 'off') ? r('unavailable', `eligible (${policyOf('fixRequests').join(', ')}), but no signed fix catalog exists`) : r('denied');
      case 'fix_approval': return r('denied', 'a tier never approves fixes');
      case 'approve_requests': return (live.platformPermissions ?? []).includes('approvals:review') || live.user.isPlatformAdmin
        ? r('allowed', 'independent reviewer (never for own requests)') : r('denied', 'not designated an independent reviewer');
    }
  }

  // ── Upgrade impact ────────────────────────────────────────────────────────

  /**
   * What presets would mean for every assignment that exists today. Nothing is
   * changed: custom assignments stay custom until someone re-creates them from
   * a preset. Reports what each would gain and lose under each tier, and flags
   * the ones holding connect/edit, which no preset reproduces.
   */
  async upgradePreview() {
    const rows = await this.prisma.technicianAssignment.findMany({
      where: { revokedAt: null },
      select: { id: true, userId: true, groupId: true, customerId: true, capabilities: true, presetId: true, expiresAt: true, customer: { select: { name: true } } },
    });
    return rows.map((a) => {
      const now = new Set(a.capabilities);
      return {
        assignmentId: a.id, business: a.customer.name, userId: a.userId, groupId: a.groupId,
        current: a.presetId ? 'preset' : 'custom (unchanged by this upgrade)', capabilities: a.capabilities,
        holdsLaunchOrCredential: a.capabilities.some((c) => c === CAP.COMPUTERS_CONNECT || c === CAP.COMPUTERS_EDIT),
        underPreset: BUILT_IN_PRESETS.map((p) => {
          const caps = new Set<string>(presetCapabilities(p.policy));
          return { tier: p.tier, gains: [...caps].filter((c) => !now.has(c)), loses: [...now].filter((c) => !caps.has(c)) };
        }),
      };
    });
  }

  async controlsFor(customerId: string | null): Promise<AccessControls> { return this.controls.effective(customerId); }
}
