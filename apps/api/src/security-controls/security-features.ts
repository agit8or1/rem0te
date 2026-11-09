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
export type Layer = 'portal' | 'launcher' | 'endpoint-agent' | 'endpoint-rustdesk' | 'technician-rustdesk' | 'offline-signing' | 'none';
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

  // ── Integration ───────────────────────────────────────────────────────────
  {
    id: 'integration', group: 'integration', name: 'ClientSt0r ticket analysis (AI-assisted)', status: 'enforced',
    protects: 'A ticket system or AI model reaching an endpoint through rem0te.',
    scope: 'Jobs from ClientSt0r under contract ticket-rmm-v1.',
    enforcedAt: ['portal'],
    enforcement: 'rem0te authorizes every job itself: a signed request, an explicit organization → business and technician → user mapping, the delegated technician\'s live access rebuilt from the database (never Platform Admin), integration:ticket_analysis, a reachable computer, and a fleet-limit admission — rechecked before each model call. A job reads bounded evidence only. It offers no actions, and its next steps are text (executable: false). A mapped ticket is context, never authority.',
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
    enforcement: 'rem0te has no command or script channel. The agent collects only an allowlisted set: inventory refresh, update scan, event-log query. Any terminal inside a RustDesk session is RustDesk\'s own feature, governed by the installed RustDesk version\'s defaults; rem0te neither restricts nor records it.',
    default: 'Not built.',
    prerequisites: ['A signed, versioned action catalog', 'Independent approval per action', 'Per-request signed intent verified on the endpoint', 'Output capture into the audit trail'],
    link: { href: DOC('security-model', 'roadmap-not-in-this-build'), label: 'Roadmap' },
    evidence: [],
  },
  {
    id: 'scripts-fixes', group: 'roadmap', name: 'Approved actions, fixes and patches', status: 'unavailable',
    protects: 'Endpoint changes made without an independent approver.',
    scope: '—',
    enforcedAt: ['none'],
    enforcement: 'Presets record fix and patch eligibility only; nothing can be dispatched. The first planned action is starting the Print Spooler on one lab workstation, with job-approval signing kept separate from release signing.',
    default: 'Not built.',
    prerequisites: ['Job-approval signing key held apart from portal administration', 'Endpoint verification of approval before execution'],
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
