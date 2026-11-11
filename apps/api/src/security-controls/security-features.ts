/**
 * Security Features catalog — what each safeguard protects, whether this
 * build actually enforces it, where, its default, what it needs, and what
 * proves it. Served at GET /security-controls/catalog (with the effective
 * state the caller is allowed to see — security-features.service.ts) and
 * rendered in Settings → Security → Security Features and Admin → Security.
 *
 * `status` is deliberately blunt:
 *   enforced     the server refuses the action; a test drives it
 *   partial      enforced at the portal, but the endpoint cannot confirm it,
 *                or enforced for some actors and not others (the row says which)
 *   advisory     shown or recorded, but nothing refuses or ends anything
 *   unavailable  no component exists to enforce it, so it cannot be enabled
 *
 * `enforcedAt` names the layer that does the refusing. A hidden button is not
 * a layer, and a portal audit event does not prove anything happened (or did
 * not happen) on the endpoint. Rewritten in 0.25.0 after a code trace found
 * the catalog and the UI claiming restrictions that only applied to
 * preset-backed technicians.
 */
export type FeatureStatus = 'enforced' | 'partial' | 'advisory' | 'unavailable';
export type Layer = 'portal' | 'launcher' | 'endpoint-agent' | 'endpoint-rustdesk' | 'technician-rustdesk' | 'offline-signing' | 'approval-signer' | 'none';
export type FeatureGroup = 'reach' | 'session' | 'evidence' | 'guardrails' | 'updates' | 'integration' | 'roadmap';
export interface SecurityFeature {
  id: string;
  group: FeatureGroup;
  name: string;
  status: FeatureStatus;
  /** What goes wrong without it, in one line. */
  protects: string;
  scope: string;
  enforcedAt: Layer[];
  enforcement: string;
  /** The shipped default, as code sets it. */
  default: string;
  prerequisites: string[];
  link: { href: string; label: string };
  evidence: string[];
  gap?: string;
}

const DOC = (page: string, anchor = '') => `/docs/${page}${anchor ? `#${anchor}` : ''}`;

export const SECURITY_FEATURES: SecurityFeature[] = [
  // ── Who can reach a computer ──────────────────────────────────────────────
  {
    id: 'business-isolation', group: 'reach', name: 'Business isolation', status: 'enforced',
    protects: 'A person in one customer business reaching another business\'s computers, sessions, credentials or audit.',
    scope: 'Every business-scoped read and write: computers, sessions, credentials, installers, enrollment and launcher tokens, audit, search.',
    enforcedAt: ['portal'],
    enforcement: 'AccessControlService resolves the business from the database on every request (the JWT is identity only). A computer is selected by its database id, never its hostname; one in another business is a 404 "Computer not found", so ids cannot be probed. Platform Admins bypass explicitly.',
    default: 'Always on.',
    prerequisites: [],
    link: { href: DOC('access-control', 'the-business-is-the-security-boundary'), label: 'Access control' },
    evidence: ['apps/api/scripts/e2e-business-access.mjs', 'scripts/check-security-invariants.mjs'],
    gap: 'A Platform Admin with no business selected sees every business, including in the Tactical RMM hostname resolver, which then matches a hostname across businesses (it answers "ambiguous" rather than guessing when more than one matches).',
  },
  {
    id: 'enrollment-binding', group: 'reach', name: 'Enrollment bound to one business', status: 'enforced',
    protects: 'A computer enrolling itself into, or moving itself to, a business it was not installed for.',
    scope: 'Enrollment tokens, installer downloads, every heartbeat.',
    enforcedAt: ['portal'],
    enforcement: 'An enrollment token is minted by someone with computers:add in that business, stored as a SHA-256 hash, expires, and is claimed once (conditional update). The business comes from the token, never from the device. A RustDesk ID already bound to a business cannot be re-enrolled elsewhere; adopting an unassigned node needs its device secret. Heartbeats authenticate with the device secret (timing-safe), never the RustDesk ID, and no heartbeat field writes the business.',
    default: 'Always on.',
    prerequisites: [],
    link: { href: DOC('access-control'), label: 'Access control' },
    evidence: ['apps/api/scripts/e2e-security-audit.mjs', 'scripts/check-security-invariants.mjs'],
    gap: 'A Platform Admin can mint a token for an existing computer in a different business, which moves it. That is an audited admin action, not something a device can do.',
  },
  {
    id: 'computer-scope', group: 'reach', name: 'Per-computer access for Business Users', status: 'enforced',
    protects: 'A Business User connecting to, or reading the password of, a computer they were not given.',
    scope: 'Connect, connect.cmd, launcher tokens, password reveal / set / rotate.',
    enforcedAt: ['portal'],
    enforcement: 'A Business User needs computers:connect and either a company-wide computer or an active ComputerAccess row (within its dates and schedule). computers:edit does not widen reach. Business Owners reach every computer in their business; Platform Admins reach all.',
    default: 'New Business User: computers:view + computers:connect, no computers until granted (or company-wide).',
    prerequisites: [],
    link: { href: '/admin/access', label: 'Access Control' },
    evidence: ['apps/api/scripts/e2e-business-access.mjs'],
  },
  {
    id: 'presets', group: 'reach', name: 'Technician presets (L1 / L2 / L3)', status: 'enforced',
    protects: 'An MSP technician getting more than their tier, or connect/credential rights from a preset.',
    scope: 'Technician assignments created from a preset, in the one business each assignment names.',
    enforcedAt: ['portal'],
    enforcement: 'Capabilities are derived live from the preset on every request. A preset can only ever yield computers:view, support:requests and computers:event_logs — never connect, edit, add, remove, quick connect or users:manage — and never releases the permanent password. Remote launch for a preset grant is decided by the launch policy (see the session rows). Dates and weekly schedules on an assignment are enforced at request time.',
    default: 'L1: inventory + support requests. L2: + event logs, basic diagnostics, attended view-only, may request control. L3: + advanced diagnostics, may request control, elevation (always refused) and patches (not built). An assignment created with no preset and no capabilities becomes L1.',
    prerequisites: ['technicians:manage to assign; Business Owner approval only where the business requires it (off by default).'],
    link: { href: '/settings/security/technician-access', label: 'Technician Access' },
    evidence: ['apps/api/scripts/unit-presets.mjs', 'apps/api/scripts/e2e-presets.mjs § presets', 'scripts/check-security-invariants.mjs § 11'],
    gap: 'Custom (non-preset) assignments keep whatever capabilities they were given, including Connect and password reveal, and launch exactly as a Business User would. An assignment created from a group that carries capabilities is custom, not a preset.',
  },
  {
    id: 'pairwise-scope', group: 'reach', name: 'Capability and computer from the same grant', status: 'enforced',
    protects: 'Overlapping groups combining one grant\'s capability with another\'s computers.',
    scope: 'Technicians with more than one assignment or group in a business.',
    enforcedAt: ['portal'],
    enforcement: 'A capability is honoured on a computer only when one grant carries both (technicianGrantAllows).',
    default: 'Always on.',
    prerequisites: [],
    link: { href: DOC('technician-access'), label: 'Technician access' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § conflicting groups'],
  },
  {
    id: 'self-promotion', group: 'reach', name: 'No self-assignment or self-approval', status: 'enforced',
    protects: 'Someone granting or approving their own access.',
    scope: 'Technician assignments, groups, platform permissions, temporary access, permissions on yourself.',
    enforcedAt: ['portal'],
    enforcement: 'An assignment cannot target its creator or a group they belong to; nobody approves their own request or edits their own permissions or level.',
    default: 'Always on.',
    prerequisites: [],
    link: { href: DOC('technicians'), label: 'MSP technicians' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § self-promotion'],
  },
  {
    id: 'protected-classes', group: 'reach', name: 'Protected device classes', status: 'enforced',
    protects: 'Interactive access to domain controllers, hypervisors, backup servers and the RMM host.',
    scope: 'Every launch, for everyone — Platform Admin included.',
    enforcedAt: ['portal'],
    enforcement: 'Default-deny. Needs an independently approved exception, activated with a fresh passkey, launched from an attested managed admin workstation. Rechecked at launch-token issue, at redemption and at command dispatch.',
    default: 'DOMAIN_CONTROLLER, HYPERVISOR, BACKUP_SERVER, RMM_HOST (mandatory); SERVER optional.',
    prerequisites: ['A computer must be classed correctly — classification is a person\'s decision, not detected.'],
    link: { href: '/settings/security/technician-access', label: 'Technician Access → Policy' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § protected', '§ stolen-session drill'],
    gap: 'Nothing in this build attests a managed admin workstation, so protected computers are unreachable interactively for everyone (fail-closed) until device attestation exists.',
  },

  // ── What a session can do ─────────────────────────────────────────────────
  {
    id: 'launch-authorization', group: 'session', name: 'Permission to launch', status: 'enforced',
    protects: 'A session being started by someone the portal would refuse.',
    scope: 'POST /connect, connect.cmd, connection-grant redemption, launcher token issue and redemption.',
    enforcedAt: ['portal', 'launcher'],
    enforcement: 'One decision for every path (authorizeConnect → evaluateLaunch → fleet limit). A refusal is a 403 with a reason code, or a 404 when the computer is out of scope. It releases a credential or a 90-second single-use grant; that is permission to launch, not a connection.',
    default: 'Always on.',
    prerequisites: [],
    link: { href: DOC('security-model', 'permission-to-launch-is-not-a-connection'), label: 'Security model' },
    evidence: ['apps/api/scripts/e2e-business-access.mjs', 'apps/api/scripts/e2e-presets.mjs § launch modes'],
    gap: 'Anyone who has seen a computer\'s permanent password can connect with any RustDesk client pointed at this server without the portal. Revoking access does not change a password already seen — rotate it (Offboarding lists which).',
  },
  {
    id: 'attended-consent', group: 'session', name: 'Attended access (user consent)', status: 'partial',
    protects: 'A session starting without the person at the computer agreeing.',
    scope: 'Preset-backed technician launches only.',
    enforcedAt: ['portal'],
    enforcement: 'With consent required, a preset launch is refused unless the computer reports it can enforce consent. Nothing reports that, so those launches are refused.',
    default: 'Policy: consent required. Endpoint: the shipped installer sets verification-method = use-permanent-password, so the computer never asks.',
    prerequisites: ['An endpoint agent that enforces and reports consent — not built.'],
    link: { href: DOC('security-model', 'what-each-session-mode-really-does'), label: 'Session modes' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § launch modes (simulated endpoint)'],
    gap: 'For Business Owners, Business Users, custom assignments and Platform Admins nobody is asked: the computer accepts the permanent password.',
  },
  {
    id: 'unattended', group: 'session', name: 'Unattended access', status: 'partial',
    protects: 'Connecting when nobody is at the computer.',
    scope: 'Launches that ask for the unattended mode.',
    enforcedAt: ['portal'],
    enforcement: 'An explicit unattended launch is refused while the policy says off.',
    default: 'Policy: off.',
    prerequisites: [],
    link: { href: '/settings/security/technician-access', label: 'Technician Access → Policy' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § launch modes'],
    gap: 'An ordinary Connect by a Business Owner, Business User, custom assignment or Platform Admin releases the permanent password to a computer that never asks for consent — in effect unattended access, whatever the policy says.',
  },
  {
    id: 'view-only', group: 'session', name: 'View-only', status: 'partial',
    protects: 'A technician who should watch being able to type or click.',
    scope: 'Preset-backed technician launches only.',
    enforcedAt: ['portal'],
    enforcement: 'A preset view-only launch is refused unless the computer reports it can enforce view-only. Nothing reports that, so it is refused rather than opened with control. The View only button is shown only in a technician context.',
    default: 'Off for L1, allowed for L2/L3 — and refused at launch by every shipped endpoint.',
    prerequisites: ['An endpoint agent that enforces view-only and reports it — not built.'],
    link: { href: DOC('security-model', 'what-each-session-mode-really-does'), label: 'Session modes' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § launch modes (simulated endpoint)'],
    gap: 'For everyone else, view-only was never applied: the session opened with full control. Before 0.25.0 the button was offered to them anyway.',
  },
  {
    id: 'input-control', group: 'session', name: 'Keyboard and mouse control', status: 'partial',
    protects: 'Interactive control outside an approved window.',
    scope: 'Preset-backed technician launches.',
    enforcedAt: ['portal'],
    enforcement: 'Control for a preset technician needs an activated temporary grant for that computer (independent approval, fresh authentication, expiry) and, with consent required, a computer that enforces consent.',
    default: 'L1 off; L2/L3 by temporary grant. Members and custom assignments with Connect: full control.',
    prerequisites: ['A second person to approve temporary grants.'],
    link: { href: DOC('technician-access', 'temporary-access'), label: 'Temporary access' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § temporary access'],
    gap: 'Once RustDesk connects, input is RustDesk\'s default. Nothing on the endpoint ends control when the grant expires, and the session-length limit is advisory.',
  },
  {
    id: 'clipboard', group: 'session', name: 'Clipboard', status: 'unavailable',
    protects: 'Data copied out of, or into, the customer\'s computer.',
    scope: 'Every RustDesk session.',
    enforcedAt: ['technician-rustdesk'],
    enforcement: 'None in rem0te. RustDesk applies clipboard on the technician\'s own client; the installer sets no endpoint option for it. Presets cannot turn it on, and the policy value is not transmitted anywhere.',
    default: 'Whatever the installed RustDesk version does by default.',
    prerequisites: ['Per-session endpoint enforcement — not built.'],
    link: { href: DOC('security-model', 'what-each-session-mode-really-does'), label: 'Session modes' },
    evidence: [],
  },
  {
    id: 'file-transfer', group: 'session', name: 'File transfer', status: 'unavailable',
    protects: 'Files leaving or arriving on the customer\'s computer.',
    scope: 'Every RustDesk session.',
    enforcedAt: ['technician-rustdesk'],
    enforcement: 'None in rem0te, as for clipboard.',
    default: 'Whatever the installed RustDesk version does by default.',
    prerequisites: ['Per-session endpoint enforcement — not built.'],
    link: { href: DOC('security-model', 'what-each-session-mode-really-does'), label: 'Session modes' },
    evidence: [],
  },
  {
    id: 'elevation', group: 'session', name: 'Elevation', status: 'unavailable',
    protects: 'Administrator rights granted through a session.',
    scope: 'Every launch.',
    enforcedAt: ['portal'],
    enforcement: 'A preset elevation launch is always refused. There is no privileged helper on the endpoint.',
    default: 'Unavailable.',
    prerequisites: ['A Windows privileged helper: authenticated named-pipe IPC with a SID-restricted DACL, per-request signed intent, no arbitrary command surface.'],
    link: { href: DOC('technician-access', 'not-built-shown-as-unavailable'), label: 'Not built' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § launch modes'],
    gap: 'Whatever rights the signed-in Windows user has are available to anyone in the session.',
  },
  {
    id: 'session-length', group: 'session', name: 'Maximum session length', status: 'advisory',
    protects: 'A session running far past what was approved.',
    scope: 'Preset launches.',
    enforcedAt: ['none'],
    enforcement: 'Shown to the technician at launch. Nothing ends the session.',
    default: 'Policy 60 min; L1 30, L2 60, L3 120.',
    prerequisites: ['Endpoint-side termination — not built.'],
    link: { href: DOC('security-model', 'what-each-session-mode-really-does'), label: 'Session modes' },
    evidence: [],
  },

  // ── What you will have afterwards ────────────────────────────────────────
  {
    id: 'session-evidence', group: 'evidence', name: 'Session evidence (launch, connection, end)', status: 'partial',
    protects: 'An after-the-fact record that claims more than happened.',
    scope: 'Every session started through the portal.',
    enforcedAt: ['portal', 'endpoint-agent'],
    enforcement: 'Each state names who may report it: Launch requested (server), Launcher acknowledged (launcher/script), Client opened (technician\'s machine — not a connection), Connection confirmed (the endpoint agent counting incoming RustDesk processes, only when exactly one launch is open; or the technician, recorded as theirs), Disconnected (agent sees the count reach 0). Duration is shown only when both ends were measured. A finished session cannot be reopened.',
    default: 'Always on; endpoint confirmation needs an agent from 0.20.0.',
    prerequisites: ['A current endpoint agent heartbeat.'],
    link: { href: DOC('connecting', 'what-the-session-status-means-v020'), label: 'Session status' },
    evidence: ['apps/api/scripts/e2e-session-mutations.mjs', 'apps/api/scripts/e2e-presets.mjs'],
    gap: 'Confirmation says someone connected, not who: two simultaneous launches confirm neither. Precision is the heartbeat interval. Connections made outside the portal with a known password leave no session. Nothing on the endpoint can terminate a session.',
  },
  {
    id: 'credential-audit', group: 'evidence', name: 'Credential reveal and launch audit', status: 'enforced',
    protects: 'Not knowing who saw a computer\'s password or tried to connect.',
    scope: 'Password reveal / set / rotate, connection grants, launcher tokens, sessions, Quick Connect, integration jobs.',
    enforcedAt: ['portal'],
    enforcement: 'ENDPOINT_PASSWORD_REVEALED (direct, and via Connect), ENDPOINT_CREDENTIAL_ROTATION_STAGED / _ROTATED, CONNECTION_GRANT_CREATED / _DENIED / _REDEEMED, PRIVILEGED_WORK_DENIED, LAUNCHER_TOKEN_ISSUED / _USED, SESSION_LAUNCHED / _COMPLETED / _CANCELED / _STATE_CHANGED, QUICK_CONNECT_*, INTEGRATION_JOB_*.',
    default: 'Always on.',
    prerequisites: [],
    link: { href: DOC('offboarding'), label: 'Access review and offboarding' },
    evidence: ['apps/api/scripts/e2e-business-access.mjs', 'apps/api/scripts/e2e-offboarding.mjs'],
    gap: 'A denied connect.cmd is recorded as ENDPOINT_PASSWORD_REVEALED with meta.denied — filter on meta, not the action name. A reveal with no stored password writes nothing. These are portal records: they prove what the portal released, not what happened on the computer.',
  },

  // ── Guardrails ────────────────────────────────────────────────────────────
  {
    id: 'replay-protection', group: 'guardrails', name: 'Single-use tokens and replay protection', status: 'enforced',
    protects: 'A captured link, token or signed request being used twice.',
    scope: 'Connection grants (90 s), launcher tokens (120 s), enrollment tokens, integration requests and delegation tokens (≤ 300 s), signed-update nonces.',
    enforcedAt: ['portal'],
    enforcement: 'Consumed by a conditional update, never read-then-write. Integration requests are Ed25519-signed with ±120 s skew, and nonces and delegation ids are stored in Postgres, so a restart does not reopen them.',
    default: 'Always on.',
    prerequisites: [],
    link: { href: DOC('integration-clientst0r'), label: 'Integration' },
    evidence: ['scripts/check-security-invariants.mjs', 'apps/api/scripts/e2e-integration.mjs'],
  },
  {
    id: 'fleet-abuse', group: 'guardrails', name: 'Fleet limits', status: 'enforced',
    protects: 'One identity — stolen or careless — touching many computers or businesses quickly.',
    scope: 'Launches, writes to computers and integration evidence, from the UI, API keys, launcher and integration.',
    enforcedAt: ['portal'],
    enforcement: 'AbuseGuardService.admit serialises per identity on a Postgres advisory lock and counts distinct computers and businesses, launches and writes in the window. A trip pauses the identity until someone else clears it, and alerts. Commands are re-checked at dispatch.',
    default: '60-minute window. Devices / businesses / launches / writes: L1 10/3/5/0, L2 15/3/10/20, L3 25/5/20/40, custom 25/5/25/50, member 40/1/40/80, Platform Admin 60/20/60/120, integration 100/50/0/0.',
    prerequisites: ['Alert destinations, if anyone should hear about a trip.'],
    link: { href: '/settings/security/technician-access', label: 'Technician Access → Policy' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § 40 concurrent'],
    gap: 'Counts what the portal hands out. A connection made outside the portal with a known password is not counted.',
  },
  {
    id: 'trust-review', group: 'guardrails', name: 'Independent review of trust widening', status: 'enforced',
    protects: 'One person loosening the controls on this page.',
    scope: 'Alert destinations, reviewer designation, thresholds, protected classes, unattended / clipboard / file transfer, consent, preset widening, device class, managed workstation, update trust mode.',
    enforcedAt: ['portal'],
    enforcement: 'Widening becomes a request decided by someone else with fresh authentication; previous contacts are alerted. Tightening applies at once; a Business Owner can only tighten their business.',
    default: 'Always on. With one Platform Admin and no reviewer, nothing that widens trust can be approved.',
    prerequisites: ['A second Platform Admin or an approvals:review holder.'],
    link: { href: '/settings/security/technician-access', label: 'Technician Access → Reviews' },
    evidence: ['apps/api/scripts/e2e-presets.mjs § trust', 'apps/api/scripts/e2e-signed-updates.mjs'],
  },

  // ── Updates ───────────────────────────────────────────────────────────────
  {
    id: 'release-signing', group: 'updates', name: 'Signed agent updates (offline-rooted)', status: 'partial',
    protects: 'A compromised portal or database installing a replacement agent, installer or RustDesk build.',
    scope: 'Windows agents running rem0te-agent.exe. Not legacy agents, not Linux/macOS, not the technician-side Connect script.',
    enforcedAt: ['offline-signing', 'endpoint-agent'],
    enforcement: 'A TUF repository signed offline (root 2-of-3; separate targets, snapshot and timestamp keys). The portal holds no key and only mirrors files. The agent runs only signed targets, with expiry, rollback and mix-and-match protection, refuses unsigned downgrades and keeps its pinned relay. In signed only, the portal gives legacy agents nothing to run.',
    default: 'Legacy allowed, and no repository configured — nothing changes until an operator publishes one.',
    prerequisites: ['Offline keys and a repository from rem0te-release', 'UPDATE_REPO_DIR', 'Agents built with the trust root, or migrated'],
    link: { href: '/settings/security/update-signing', label: 'Update Signing' },
    evidence: ['tools/windows-installer/internal/trust/chain_test.go', 'tools/windows-installer/internal/agent/agent_test.go', 'apps/api/scripts/e2e-signed-updates.mjs', 'scripts/check-security-invariants.mjs § 12'],
    gap: 'Fixture-tested only; not yet run on a real Windows lab machine. No Authenticode signature, so the first download is trusted as downloaded. Legacy agents trust the portal until migrated. Customer policy in the database is not signed.',
  },

  // ── Approved actions (0.26) ───────────────────────────────────────────────
  {
    id: 'approved-actions', group: 'guardrails', name: 'Approved actions (Print Spooler; Windows updates; maintenance)', status: 'partial',
    protects: 'An AI suggestion, a technician, a compromised portal or a compromised database changing a customer computer without independent human approval.',
    scope: 'Two catalog actions, run by signed Windows agents: start the Windows Print Spooler once (windows.service.start@1) on one computer, and from 0.27 install named Windows updates (windows.update.install@1) on the computers of one patch ring, requested only through a staged deployment (see Staged Windows patching). From 0.32, four maintenance actions on one computer, each needing two distinct approvers on any computer: restart one service from a fixed allowlist (windows.service.restart@1: Spooler, wuauserv, BITS, W32Time, WinRM, RustDesk), schedule a restart after a fixed warning of 5 minutes to 24 hours (windows.reboot.schedule@1), cancel it (windows.reboot.cancel@1), and collect a fixed, bounded, redacted set of logs (windows.logs.collect@1, which also needs computers:event_logs). Nothing else can be requested; there is no command, script, path or URL parameter anywhere.',
    enforcedAt: ['portal', 'approval-signer', 'endpoint-agent', 'offline-signing'],
    enforcement: 'The portal only proposes. A separate approval signer — its own process, Unix user, key, roster and policy, on its own origin — signs the exact plan (action version, agent build, parameters, immutable target, policy, approvers, window, single-use job id) only after user-verified passkey approvals from roster members who are not the requester: one for a standard workstation, two distinct for anything else, plus a distinct customer sign-off where that business requires it. The agent verifies that signature with keys from the offline-rooted update chain, recomputes risk from its own product type, checks its own identity, the window and its build, journals the job before acting and never runs a job id twice. The portal rechecks the requester\'s live access, the device and the fleet limits before delivering. An uncertain outcome blocks retries until a person reconciles it.',
    default: 'Off until an approval signer is configured (APPROVAL_SIGNER_INTERNAL_URL) and its keys are published as approval/keys.json in the signed repository.',
    prerequisites: ['Approval signer installed and keyed', 'Approvers enrolled on its roster (fingerprint ceremony)', 'approval/keys.json signed into the update repository', 'Agents on the published 0.26+ signed build (0.27+ for updates, 0.32+ for maintenance)'],
    link: { href: DOC('approved-actions'), label: 'Approved actions' },
    evidence: ['tools/windows-installer/internal/action/action_test.go', 'tools/windows-installer/internal/action/maintenance_test.go', 'apps/api/scripts/unit-approval-signer.mjs', 'apps/api/scripts/e2e-approved-action.mjs', 'apps/api/scripts/e2e-maintenance-actions.mjs', 'scripts/check-security-invariants.mjs § 14'],
    gap: 'Fixture-tested only: the agent\'s decision code against a simulated Windows, and synthetic passkeys. Not yet run on a real lab workstation (the service manager, shutdown.exe, wevtutil and the RustDesk session check have never run on Windows). The result shows the service state, never that a document printed; a scheduled restart is reported as scheduled, not as done; the RustDesk session check is made once, when the restart is scheduled. A compromised portal can still delay, cancel or withhold delivery (denial of service), and could re-deliver an envelope the agent has already consumed (which it answers from its journal).',
  },

  // ── Staged Windows patching (0.27) ────────────────────────────────────────
  {
    id: 'staged-patching', group: 'guardrails', name: 'Staged Windows patching', status: 'partial',
    protects: 'A bad Windows update, a compromised portal or database, or an impatient technician reaching every computer at once, or installing something nobody approved.',
    scope: 'Security, critical, rollup and ordinary Windows updates on signed Windows agents, named by Windows Update identity and revision (at most 20 per plan). Not drivers, feature upgrades, optional or preview updates, anything needing a licence or user input, third-party software, or computers whose updates are managed by WSUS, Windows Update for Business policy, MDM or Configuration Manager.',
    enforcedAt: ['portal', 'approval-signer', 'endpoint-agent', 'offline-signing'],
    enforcement: 'A deployment is a canary (ring 0, exactly one computer) and up to four further rings of at most 25. Each ring is one signed plan naming every computer, always high impact: two distinct roster approvers with passkeys, never the requester. The next ring cannot be requested until the canary reports every update effective (a later scan no longer offers it, Windows\' history records it, no restart pending), the ring is within its failure threshold, any uncertain computer is reconciled and the soak time has passed; over the threshold the deployment pauses itself. Each computer checks the signature, that it is named, and that no other update manager owns it, then asks Windows Update itself whether each update is offered and eligible; the plan\'s titles are never consulted. It never restarts the computer, never accepts a licence, runs detached under a lock, and journals before installing, so a re-delivered plan is answered, not re-run.',
    default: 'Off until approved actions are (approval signer configured) and agents run the 0.27 signed build.',
    prerequisites: ['Approved actions configured', 'Agents on the published 0.27+ signed build, reporting patch posture', 'A canary computer that is offered the updates'],
    link: { href: DOC('staged-patching'), label: 'Staged patching' },
    evidence: ['tools/windows-installer/internal/patch/patch_test.go', 'tools/windows-installer/internal/action/updates_test.go', 'apps/api/scripts/e2e-staged-patching.mjs', 'scripts/check-security-invariants.mjs § 15'],
    gap: 'Fixture-tested only: the agent\'s real decision code against a simulated Windows Update and registry, and synthetic passkeys. The Windows Update script is parsed by PowerShell in CI but has not run against a real Windows Update service. Rem0te never restarts computers, so "restart required" waits for a person. Effective is what the computer reports; it does not prove a vulnerability is gone. Uninstall (rollback) is not built.',
  },

  // ── Containment and evidence (0.28) ───────────────────────────────────────
  {
    id: 'containment', group: 'guardrails', name: 'Containment: write pause and business suspension', status: 'partial',
    protects: 'An incident spreading while people work out what happened: a phished account, a compromised technician, a misbehaving integration or a portal that may itself be compromised.',
    scope: 'Four kinds of write: approved actions (including patch plans), remote connections (Connect and Quick Connect), agent and RustDesk update instructions, and ClientSt0r jobs. A pause is global, or for one business. Viewing, reporting and the audit log keep working.',
    enforcedAt: ['portal', 'approval-signer', 'endpoint-agent', 'offline-signing'],
    enforcement: 'Portal: every write path asks before it acts (action requests and the dispatch of already-approved plans, every connection, Quick Connect admission, heartbeat update and reinstall flags and rollout dispatch, integration submit and worker). Setting a pause needs no fresh authentication; lifting one does. A business\'s own suspension is lifted only by that business\'s owner; an MSP pause only by someone other than whoever set it. Approval signer: a pause covering actions is sent to it, and it then refuses new plans and every approval decision; the portal can add a pause there but has no way to lift one — that is the signer operator\'s CLI. Agent: control/pause.json, published with the offline release keys, makes agents refuse approved actions (and optionally the update command) whatever the portal delivers; an unreadable listed pause is treated as a pause.',
    default: 'Nothing paused. The portal pause is available to Platform Admins, technician managers and Business Owners as soon as 0.28 is installed.',
    prerequisites: ['For the signer layer: the 0.28 approval signer build', 'For the agent layer: the offline release keys and agents on a 0.28+ signed build'],
    link: { href: DOC('containment'), label: 'Containment' },
    evidence: ['apps/api/scripts/e2e-containment.mjs', 'tools/windows-installer/internal/action/pause_test.go', 'tools/windows-installer/internal/agent/agent_test.go', 'scripts/check-security-invariants.mjs § 16'],
    gap: 'A compromised portal can ignore its own pause; the signer and signed-pause layers are what hold then. Withholding a newer signed pause works until the signed timestamp expires (7 days by default). An agent that has already started an action finishes it. Maintenance windows (0.29, Monitoring) silence alert notifications only; they never lift or set a pause. Fixture-tested only.',
  },
  {
    id: 'audit-chain', group: 'evidence', name: 'Tamper-evident audit log', status: 'partial',
    protects: 'Someone with database access quietly editing or deleting the record of what happened.',
    scope: 'Every audit log entry, from the first.',
    enforcedAt: ['portal', 'offline-signing'],
    enforcement: 'Each entry is hashed onto the one before it within seconds of being written (sequence, time, action, actor, address, resource, metadata and the business, user and tenant it named). A database trigger refuses any change to a sealed entry except clearing a reference to a deleted user or business. The chain is recomputed at start and hourly, and a break raises an alert. Entries are streamed off the host (AUDIT_EXPORT_FILE / AUDIT_EXPORT_URL) with Ed25519-signed checkpoints, and rem0te-audit verify --export compares the two entry by entry — which is what catches someone who rewrote the whole chain in the database.',
    default: 'Sealing and verification are on. Export and signed checkpoints are off until configured.',
    prerequisites: ['AUDIT_EXPORT_URL or AUDIT_EXPORT_FILE on storage the portal host cannot rewrite', 'AUDIT_CHECKPOINT_KEY_FILE, with the public key kept off the host'],
    link: { href: DOC('containment', 'the-tamper-evident-audit-log'), label: 'Audit integrity' },
    evidence: ['apps/api/scripts/unit-audit-chain.mjs', 'apps/api/scripts/e2e-containment.mjs', 'scripts/check-security-invariants.mjs § 16'],
    gap: 'Detects, does not prevent: a database superuser can still delete rows or drop the trigger, and is caught by verification and the export, not stopped. It cannot prove an event was ever logged. Without an export, an attacker who rewrites every hash is not detected. The checkpoint key on the host signs whatever the host says.',
  },

  {
    id: 'monitoring', group: 'evidence', name: 'Monitoring, alerts and maintenance windows', status: 'partial',
    protects: 'A computer, service or site failing with nobody told — and alert noise or a maintenance window hiding a real problem.',
    scope: 'Computers with monitors in effect (global, business, site or computer scope; the most specific wins).',
    enforcedAt: ['portal', 'endpoint-agent'],
    enforcement: 'Read-side only. The heartbeat hands an authenticated agent the services to read and event queries to count; the agent checks every name and log against fixed rules and changes nothing, and the server keeps only what it asked for. One open alert per problem (a database index enforces it); offline alerts wait a few minutes so a site going dark is one outage alert. Notification and escalation go to webhooks set by a Business Owner or the MSP with fresh authentication (business destinations: public HTTPS hosts only). A maintenance window silences notification and escalation, never the alert itself, and never touches a containment pause or a security alert. Alert events to ClientSt0r are signed and sequenced per organization; a linked ticket grants nothing.',
    default: 'No monitors exist until someone adds them (Settings → Monitoring offers a recommended set). Nobody is notified until a policy names destinations.',
    prerequisites: ['Monitors at some scope', 'A notification policy with destinations', 'Service and event monitors need agents from 0.29 (re-run the installer)'],
    link: { href: DOC('monitoring'), label: 'Monitoring' },
    evidence: ['apps/api/scripts/unit-monitoring.mjs', 'apps/api/scripts/e2e-monitoring.mjs', 'scripts/check-security-invariants.mjs § 17'],
    gap: 'Fixture-tested only: the PowerShell monitor block has run against stubs, not a real Windows service manager or event log. Webhook delivery is best-effort (no retry queue); a destination that is down misses that notification, which the alert history records. Restart-pending age counts from when rem0te first saw it. No e-mail or SMS channel.',
  },

  // ── Integration ───────────────────────────────────────────────────────────
  {
    id: 'integration', group: 'integration', name: 'ClientSt0r ticket analysis (AI-assisted)', status: 'enforced',
    protects: 'A ticket system or AI model reaching an endpoint through rem0te.',
    scope: 'Jobs from ClientSt0r under contract ticket-rmm-v1.',
    enforcedAt: ['portal'],
    enforcement: 'rem0te authorizes every job itself: a signed request, an explicit organization → business and technician → user mapping, the delegated technician\'s live access rebuilt from the database (never Platform Admin), integration:ticket_analysis, a reachable computer, and a fleet-limit admission — rechecked before each model call. A job reads bounded evidence only, and its next steps are text (executable: false). From 0.26 ClientSt0r may also propose the one catalog action, as the delegated technician; a proposal authorizes nothing (see Approved actions). A mapped ticket is context, never authority.',
    default: 'Off until INTEGRATION_PEERS_FILE is configured.',
    prerequisites: ['Peers file and keys on the server', 'Organization and technician mappings'],
    link: { href: DOC('integration-clientst0r'), label: 'ClientSt0r integration' },
    evidence: ['apps/api/scripts/e2e-integration.mjs', 'scripts/check-security-invariants.mjs'],
    gap: 'Fixture-tested against a simulated ClientSt0r; not yet paired with a real one.',
  },

  // ── Roadmap: not in this build ────────────────────────────────────────────
  {
    id: 'remote-shell', group: 'roadmap', name: 'Background terminal and PowerShell', status: 'unavailable',
    protects: 'Commands running on a customer computer outside any session.',
    scope: '—',
    enforcedAt: ['none'],
    enforcement: 'rem0te has no command or script channel. The agent collects only an allowlisted set — inventory refresh, update scan, event-log query — and runs only compiled-in catalog actions (two, in 0.27). Any terminal inside a RustDesk session is RustDesk\'s own feature, governed by the installed RustDesk version\'s defaults; rem0te neither restricts nor records it.',
    default: 'Not built.',
    prerequisites: ['A signed, versioned action catalog', 'Independent approval per action', 'Per-request signed intent verified on the endpoint', 'Output capture into the audit trail'],
    link: { href: DOC('security-model', 'roadmap-not-in-this-build'), label: 'Roadmap' },
    evidence: [],
  },
  {
    id: 'scripts-fixes', group: 'roadmap', name: 'Scripts, further fixes and patches', status: 'unavailable',
    protects: 'Endpoint changes beyond the two catalog actions.',
    scope: '—',
    enforcedAt: ['none'],
    enforcement: 'Only the Print Spooler start and Windows update installs exist (see Approved actions and Staged Windows patching). Drivers, feature upgrades, third-party software and reboots are not built. Each further action ships as a new catalog version compiled into a new signed agent build, with its own warnings and verification; scripts are not planned as a free-form channel.',
    default: 'Not built.',
    prerequisites: ['A catalog entry per action, versioned', 'Its own verification step on the endpoint'],
    link: { href: DOC('security-model', 'roadmap-not-in-this-build'), label: 'Roadmap' },
    evidence: [],
  },
  {
    id: 'chat', group: 'roadmap', name: 'Chat with the user', status: 'unavailable',
    protects: 'A conversation with the customer that is not recorded.',
    scope: '—',
    enforcedAt: ['none'],
    enforcement: 'rem0te has no chat. RustDesk\'s in-session chat, where the installed version offers it, is outside rem0te and is not recorded. Support requests are the recorded channel.',
    default: 'Not built.',
    prerequisites: [],
    link: { href: DOC('support-requests'), label: 'Support requests' },
    evidence: [],
  },
  {
    id: 'mdm', group: 'roadmap', name: 'Mobile device management', status: 'unavailable',
    protects: 'Lost or non-compliant phones and tablets.',
    scope: '—',
    enforcedAt: ['none'],
    enforcement: 'Not built. Planned order: read-only inventory with ownership and freshness, then compliance, then acknowledged Lost Mode per platform; wipe and location under separate approval. Unsupported or personally owned devices must never expose prohibited commands.',
    default: 'Not built.',
    prerequisites: ['Apple supervised enrollment / eligible company-owned Android', 'Platform credentials and quotas'],
    link: { href: DOC('security-model', 'roadmap-not-in-this-build'), label: 'Roadmap' },
    evidence: [],
  },
  {
    id: 'backup-recovery', group: 'roadmap', name: 'Backup, verified recovery and standby', status: 'unavailable',
    protects: 'Believing a backup is restorable because a job turned green.',
    scope: '—',
    enforcedAt: ['none'],
    enforcement: 'Not built. Planned: Windows image backups to an independently administered destination, restore-point inventory, file restore, and a recovery badge only after a boot, service and data check in an isolated network.',
    default: 'Not built.',
    prerequisites: ['An independently administered backup engine and destination', 'An isolated restore network'],
    link: { href: DOC('security-model', 'roadmap-not-in-this-build'), label: 'Roadmap' },
    evidence: [],
  },
];
