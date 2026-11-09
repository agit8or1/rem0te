/**
 * Security Features catalog — what each safeguard covers, whether it is
 * actually enforced in this build, where, and what proves it. Served at
 * GET /security-controls/catalog and rendered in Admin → Security.
 *
 * `status` is deliberately blunt:
 *   enforced     the server refuses the action; a test drives it
 *   partial      enforced at the portal, but the endpoint cannot confirm it
 *   unavailable  no component exists to enforce it, so it cannot be enabled
 */
export type FeatureStatus = 'enforced' | 'partial' | 'unavailable';
export interface SecurityFeature { id: string; name: string; scope: string; status: FeatureStatus; enforcement: string; evidence: string[]; gap?: string }

export const SECURITY_FEATURES: SecurityFeature[] = [
  {
    id: 'presets', name: 'Technician access presets (L1 / L2 / L3)', status: 'enforced',
    scope: 'Every technician assignment created from a preset.',
    enforcement: 'Capabilities are derived live from the preset policy on every request (TechnicianAccessService.toSource). A preset can never yield computers:connect, computers:edit, add, remove, quick connect or users:manage. Capability and computer scope are evaluated from the same grant.',
    evidence: ['apps/api/scripts/unit-presets.mjs', 'apps/api/scripts/e2e-presets.mjs § presets', 'scripts/check-security-invariants.mjs § 11'],
  },
  {
    id: 'pairwise-scope', name: 'Pairwise capability × computer scope', status: 'enforced',
    scope: 'Technicians with more than one assignment or group in a business.',
    enforcement: 'A capability is honoured on a computer only when ONE grant carries both (technicianGrantAllows). Overlapping groups no longer union capability from one grant with scope from another.',
    evidence: ['apps/api/scripts/e2e-presets.mjs § conflicting groups'],
  },
  {
    id: 'session-separation', name: 'Separate view, control, elevation, clipboard, file transfer, credential, unattended', status: 'partial',
    scope: 'Every session start: POST /connect, connect.cmd, connection-grant and launcher redemption.',
    enforcement: 'AccessPolicyService.evaluateLaunch decides per mode. Preset launches never reveal the permanent password. View-only and attended consent are only allowed where the endpoint reports it can enforce them (Endpoint.sessionEnforcement); otherwise the launch is blocked with the reason. Elevation is unavailable.',
    evidence: ['apps/api/scripts/e2e-presets.mjs § launch modes'],
    gap: 'No shipped endpoint agent reports sessionEnforcement, so every view-only and consent-gated launch is blocked today. Clipboard and file transfer are client-side RustDesk toggles and cannot be enforced per session. Endpoint-confirmed termination is not implemented: RustDesk does not report it.',
  },
  {
    id: 'protected-classes', name: 'Protected device classes', status: 'enforced',
    scope: 'Domain controllers, hypervisors, backup servers, the RMM host (and any class an admin adds).',
    enforcement: 'Default-deny for everyone, Platform Admin included. Needs an independently approved PROTECTED_EXCEPTION, activated with a fresh passkey, launched through the launcher from a managed admin workstation. Rechecked at launch-token issue, at redemption, and at command dispatch. Removing a class or marking a workstation managed is a trust change.',
    evidence: ['apps/api/scripts/e2e-presets.mjs § protected', '§ stolen-session drill'],
    gap: 'Nothing in this build attests a managed admin workstation: the launcher carries no device key, so no launch can prove where it came from. The requirement therefore cannot be met and protected computers are unreachable interactively for everyone — fail-closed, by design, until device attestation exists. Approvals and activation of exceptions work and are audited.',
  },
  {
    id: 'fleet-abuse', name: 'Fleet-abuse thresholds', status: 'enforced',
    scope: 'Launches, writes to computers and integration evidence, from UI, API keys, launcher and integration.',
    enforcement: 'AbuseGuardService.admit serialises per identity on a Postgres advisory lock and counts distinct computers and businesses plus launches and writes in the window. A trip pauses the identity and alerts. Pause and alert suppression are separate. Maintenance exceptions need an independent approver, named computers and an expiry.',
    evidence: ['apps/api/scripts/e2e-presets.mjs § 40 concurrent'],
    gap: 'There is no scheduler entry point in this build; when one is added it must call admit().',
  },
  {
    id: 'trust-review', name: 'Independent review of trust widening', status: 'enforced',
    scope: 'Alert destinations (recovery contacts), independent-reviewer designation, thresholds, protected classes, unattended access, preset widening, device-class downgrade, managed workstation.',
    enforcement: 'Widening becomes a TrustChangeRequest decided by someone else (Platform Admin or approvals:review), with fresh authentication. Previous contacts are alerted on request and on decision. Before/after are recorded; policies hold no secrets.',
    evidence: ['apps/api/scripts/e2e-presets.mjs § trust'],
  },
  {
    id: 'self-promotion', name: 'No self-assignment or self-promotion', status: 'enforced',
    scope: 'Technician assignments, groups, platform permissions, temporary access.',
    enforcement: 'An assignment cannot target the person creating it or a group they belong to; nobody approves their own request.',
    evidence: ['apps/api/scripts/e2e-presets.mjs § self-promotion'],
  },
  {
    id: 'privileged-helper', name: 'Windows privileged helper hardening', status: 'unavailable',
    scope: 'A Windows service that performs elevated work on behalf of a session.',
    enforcement: 'None — no privileged helper exists in rem0te. Elevation is therefore shown as Unavailable everywhere and cannot be enabled.',
    evidence: [],
    gap: 'Before any helper ships: authenticated named-pipe IPC with a SID-restricted DACL, per-request signed intent from the portal, no arbitrary command surface, and tests for impersonation and pipe squatting.',
  },
  {
    id: 'release-signing', name: 'Release signing and provenance', status: 'unavailable',
    scope: 'Agent and installer releases.',
    enforcement: 'None — no release-signing workflow exists. Installers are generated per-request by the API, not built by CI.',
    evidence: [],
    gap: 'Isolate PR builds from signing secrets, pin workflow actions to commit SHAs, publish provenance and verify it at install, refuse installers built from forks, separate signing keys per channel.',
  },
];
