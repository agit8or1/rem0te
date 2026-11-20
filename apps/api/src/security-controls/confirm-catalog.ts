/**
 * The "confirm it is you" catalog (0.49). One list of every function that
 * asks a signed-in person to confirm it is them again (the step-up dialog:
 * password, authenticator code or passkey) before it goes ahead.
 *
 * This file is the one copy. The API decides with it (review.ts
 * `confirmRequired`, `assertFresh`, `StepUpService.assert`), and the console
 * reads it from `GET /security/confirm-policy` — the web holds no list of its
 * own, only the keys it words its prompts by, and §62 checks each of those is
 * here.
 *
 * Each step-up site in the API names exactly one key. A Platform Admin sets
 * each configurable key to `ask` or `off` under Settings → Confirm it is you
 * (ConfirmPolicy rows, migration 0071). A key with no row takes its `default`
 * here.
 *
 * 0.64, at the owner's request ("2fa is still enabled on all features, turn
 * off by default, just on login"): every key defaults to `off`, so a fresh
 * install asks only at sign-in (with its MFA). This reverses 0.49's "every
 * key defaults to ask". It does not touch the fail-closed rules: an unknown
 * key, an always-ask key, or a policy not yet read from the database still
 * asks, and a row saying `ask` still asks.
 *
 * ALWAYS_ASK is not configurable and never shown as a toggle: changing your
 * own password, authenticator or passkeys, the step-up itself, a
 * protected-device exception's passkey, and turning a confirmation off here.
 * Nothing in ConfirmPolicyService accepts one of those keys.
 *
 * Plain data: no imports, so nothing else is pulled in with it.
 */

export const CONFIRM_GROUPS = [
  'Software',
  'Patching & updates',
  'Approved actions & scripts',
  'Agents',
  'Devices & enrolment',
  'Monitoring & notifications',
  'Reports & email',
  'Integrations',
  'Security & access',
] as const;
export type ConfirmGroup = (typeof CONFIRM_GROUPS)[number];

export type ConfirmValue = 'ask' | 'off';

export interface ConfirmFunction {
  key: string;
  group: ConfirmGroup;
  label: string;
  /** One line: what it does and why it asked. */
  description: string;
  /** The step-up dialog's "To …, confirm your identity". */
  prompt: string;
  default: ConfirmValue;
}

export const CONFIRM_CATALOG = [
  // ── Software ────────────────────────────────────────────────────────────
  { key: 'software.catalog', group: 'Software', label: 'Software catalog changes', default: 'off',
    prompt: 'change a software catalog',
    description: 'Adding, editing or archiving a catalog entry, including one-click and bulk adds from winget.' },

  // ── Patching & updates ──────────────────────────────────────────────────
  { key: 'patching.policy', group: 'Patching & updates', label: 'Patch policies', default: 'off',
    prompt: 'create or revoke a patch policy',
    description: 'Creating or revoking a patch policy, which decides what installs ring by ring.' },
  { key: 'patching.override', group: 'Patching & updates', label: "A computer's patch policy", default: 'off',
    prompt: "change which patch policy a computer follows",
    description: "Setting one computer to inherit its business's company-wide policy, to be excluded, or to use another policy (0.50)." },
  { key: 'updates.schedule', group: 'Patching & updates', label: 'Automatic client updates', default: 'off',
    prompt: 'turn on automatic client updates',
    description: 'Turning on scheduled RustDesk client updates, or removing a site or group policy that could hand computers to one.' },

  // ── Approved actions & scripts ──────────────────────────────────────────
  { key: 'actions.direct', group: 'Approved actions & scripts', label: 'Direct-mode requests', default: 'off',
    prompt: 'request a direct-mode action',
    description: 'In direct mode, a request is signed at once: computer actions, patch and software rings, services, processes and script runs.' },
  { key: 'scripts.direct', group: 'Approved actions & scripts', label: 'Direct-mode script proposals', default: 'off',
    prompt: "add a script to the approval signer's allowlist",
    description: "In direct mode, proposing a script adds it to the approval signer's allowlist at once." },
  { key: 'automation.policy', group: 'Approved actions & scripts', label: 'Automation schedules', default: 'off',
    prompt: 'create, resume or revoke an automation schedule',
    description: 'Proposing a recurring script run or software install (0.58), resuming a paused one, or revoking one. Pausing never asks.' },
  { key: 'restart.window', group: 'Approved actions & scripts', label: 'Restart windows', default: 'off',
    prompt: 'set a restart window',
    description: 'Setting or changing a restart window on a business, device group or computer (0.60), or removing one so a computer inherits another. Setting "no automatic restarts", and removing a business\'s window, never ask.' },

  // ── Agents ──────────────────────────────────────────────────────────────
  { key: 'agent.migrate', group: 'Agents', label: 'Upgrade to the full agent', default: 'off',
    prompt: 'upgrade computers to the signed agent',
    description: 'Upgrading a computer, or a selection, to the full (signed) agent: runs a portal-served script on each once.' },
  { key: 'agent.autoupdate.computer', group: 'Agents', label: 'Automatic agent updates: one computer', default: 'off',
    prompt: "turn on one computer's automatic agent updates",
    description: "Turning a computer's automatic agent updates On, or back to Inherit. Off never asks." },
  { key: 'agent.autoupdate.business', group: 'Agents', label: 'Automatic agent updates: one business', default: 'off',
    prompt: "turn on a business's automatic agent updates",
    description: "Turning a business's automatic agent updates on or to a window. Off never asks." },
  { key: 'agent.autoupdate', group: 'Agents', label: 'Automatic agent updates: whole fleet', default: 'off',
    prompt: 'change automatic agent updates for the whole fleet',
    description: 'Changing the fleet-wide automatic agent update settings (Settings → Client updates).' },
  { key: 'agent.automigrate', group: 'Agents', label: 'Automatic migration', default: 'off',
    prompt: 'widen, resume or restart the automatic migration',
    description: 'Turning on the automatic migration to the signed agent, shortening its soak, or resuming or restarting it.' },

  // ── Devices & enrolment ─────────────────────────────────────────────────
  { key: 'enrollment.create', group: 'Devices & enrolment', label: 'Install links', default: 'off',
    prompt: 'make an install link',
    description: 'Making an install link or command: an enrolment token adds a computer to a business.' },
  { key: 'credential.reveal', group: 'Devices & enrolment', label: 'Computer passwords', default: 'off',
    prompt: 'reveal a computer password',
    description: "Revealing a computer's stored RustDesk password, or connecting with it." },
  { key: 'msa.grant', group: 'Devices & enrolment', label: 'Managed Secure Access test grants', default: 'off',
    prompt: 'issue a test session grant',
    description: 'Issuing a Managed Secure Access test grant to a computer, or making the grant key (Platform Admin; only while the server runs with MSA_GRANTS=on, which is off by default).' },
  // 0.72: Managed Secure Access build step 4.
  { key: 'msa.cutover', group: 'Devices & enrolment', label: 'Managed Secure Access cutover', default: 'off',
    prompt: 'move a computer into Managed Secure Access',
    description: 'Moving one computer from Legacy into Managed Secure Access, or confirming it verified after a managed test session (Platform Admin; only with MSA_GRANTS=on). Rolling back never asks.' },
  { key: 'msa.reveal', group: 'Devices & enrolment', label: 'Managed test session password', default: 'off',
    prompt: 'see the one-time password',
    description: "Showing a managed test grant's one-time RustDesk password, once (Platform Admin; only with MSA_GRANTS=on)." },
  // 0.57: discovery and adoption.
  { key: 'devices.adopt', group: 'Devices & enrolment', label: 'Adopting unassigned computers', default: 'off',
    prompt: 'assign or forget unassigned computers',
    description: 'Assigning computers from the unassigned pool to a business and site, or forgetting them.' },
  { key: 'deployment.keys', group: 'Devices & enrolment', label: 'Deployment keys', default: 'off',
    prompt: 'create a deployment key',
    description: 'Creating a multi-use deployment key for GPO, Intune, RMM or script rollout. Revoking never asks.' },
  { key: 'adoption.mappings', group: 'Devices & enrolment', label: 'Assignment rules', default: 'off',
    prompt: 'add an assignment rule',
    description: 'Adding a rule that suggests a business and site for unassigned computers. Removing one never asks.' },

  // ── Monitoring & notifications ──────────────────────────────────────────
  { key: 'monitoring.notify', group: 'Monitoring & notifications', label: 'Who is notified', default: 'off',
    prompt: 'change who is notified',
    description: 'Changing a notification policy: where alert text, including computer names, is sent.' },
  { key: 'monitoring.autoticket', group: 'Monitoring & notifications', label: 'Automatic tickets from alerts', default: 'off',
    prompt: 'change which alerts open tickets',
    description: 'Changing or removing the rule that opens a PSA ticket when an alert opens: tickets carry the alert and the computer name.' },
  { key: 'monitoring.qualityrule', group: 'Monitoring & notifications', label: 'Approving alert quality rules', default: 'off',
    prompt: 'approve an alert quality rule',
    description: 'Approving a rule that suppresses, downgrades or holds back matching alerts. Rejecting or rolling one back never asks.' },

  // ── Reports & email ─────────────────────────────────────────────────────
  { key: 'email.relay', group: 'Reports & email', label: 'Email relay', default: 'off',
    prompt: 'change the email relay',
    description: 'Saving the SMTP relay that every alert email and report goes through.' },
  { key: 'email.recipients', group: 'Reports & email', label: 'Email recipients', default: 'off',
    prompt: 'change email recipients',
    description: 'Adding or removing a confirmed email recipient, or resending its confirmation link.' },
  { key: 'reports.schedule', group: 'Reports & email', label: 'Scheduled reports', default: 'off',
    prompt: 'create or change a scheduled report',
    description: 'Creating or changing a scheduled report: who receives an export of computers by email.' },

  // ── Integrations ────────────────────────────────────────────────────────
  { key: 'ai.settings', group: 'Integrations', label: 'AI provider', default: 'off',
    prompt: 'change the AI provider or its key',
    description: 'Changing the AI provider, its key or base URL.' },
  { key: 'psa.connector', group: 'Integrations', label: 'PSA / ticketing connectors', default: 'off',
    prompt: 'change where tickets are sent',
    description: 'Changing or removing a ticketing connector: where tickets, with computer details, are sent.' },
  { key: 'warranty.settings', group: 'Integrations', label: 'Warranty lookups', default: 'off',
    prompt: 'change a warranty lookup or its credential',
    description: 'Switching a vendor warranty lookup on or off, or changing its credential: serial numbers are sent to that vendor.' },
  { key: 'apikey.create', group: 'Integrations', label: 'API keys', default: 'off',
    prompt: 'create an API key',
    description: 'Creating an API key: a key keeps working after you sign out.' },

  // ── Security & access ───────────────────────────────────────────────────
  { key: 'containment.lift', group: 'Security & access', label: 'Lifting a containment pause', default: 'off',
    prompt: 'lift a containment pause',
    description: 'Lifting a pause on remote access, actions, updates or notifications. Setting one never asks.' },
  { key: 'temporary.access', group: 'Security & access', label: 'Temporary access', default: 'off',
    prompt: 'decide or activate temporary access',
    description: 'Deciding or activating a temporary access request. A protected-device exception always needs a passkey.' },
  { key: 'security.controls', group: 'Security & access', label: 'Security controls', default: 'off',
    prompt: 'change security controls',
    description: 'Presets, access policies, device classes, technician devices, maintenance exceptions and alert suppressions.' },
  { key: 'security.trust', group: 'Security & access', label: 'Trust changes', default: 'off',
    prompt: 'decide a trust change',
    description: 'Approving or rejecting a requested trust change.' },
  { key: 'chat.recording', group: 'Security & access', label: 'Chat recording', default: 'off',
    prompt: 'change whether chats are recorded',
    description: 'Changing whether chats are recorded, for a business or the platform.' },
  { key: 'update.trust', group: 'Security & access', label: 'Update trust', default: 'off',
    prompt: 'change how agent updates are trusted',
    description: 'Changing the update-trust mode (signed only, or legacy portal migration).' },
  { key: 'scripts.review', group: 'Security & access', label: 'Approving a script', default: 'off',
    prompt: 'approve a script version',
    description: 'Approving a script version in the library. Rejecting never asks.' },
  { key: 'permissions.change', group: 'Security & access', label: 'Permissions and roles', default: 'off',
    prompt: 'change permissions',
    description: "Changing a business user's capabilities or role, or offboarding someone." },
  { key: 'technicians.manage', group: 'Security & access', label: 'Technician access', default: 'off',
    prompt: 'manage technician access',
    description: 'Technician assignments, groups and platform permissions, and ClientSt0r mappings.' },
  { key: 'sso.configure', group: 'Security & access', label: 'Single sign-on', default: 'off',
    prompt: 'change single sign-on settings',
    description: 'Configuring an OIDC provider, or linking and unlinking an account (including confirming a suggested link).' },
  { key: 'sso.enforce', group: 'Security & access', label: 'Requiring single sign-on', default: 'off',
    prompt: 'require single sign-on',
    description: "Setting a business's (or staff) sign-in mode to required, which refuses password and passkey sign-in for linked accounts. Lowering it never asks." },
  { key: 'breakglass.manage', group: 'Security & access', label: 'Break-glass accounts', default: 'off',
    prompt: 'change a break-glass account',
    description: 'Marking a Platform Admin as a break-glass account (exempt from required single sign-on), or clearing it.' },
  { key: 'platform.configure', group: 'Security & access', label: 'Public address', default: 'off',
    prompt: "change the server's public address",
    description: "Changing the server's public address, which every agent and link is built from." },
] as const satisfies readonly ConfirmFunction[];

export type ConfirmKey = (typeof CONFIRM_CATALOG)[number]['key'];
export const CONFIRM_KEYS: readonly ConfirmKey[] = CONFIRM_CATALOG.map((f) => f.key);

/**
 * Always asks, whatever the policy. Not configurable, not shown as a toggle,
 * refused by PUT /security/confirm-policy. Password and authenticator changes
 * ask for the current password or code in their own forms; the rest go
 * through the step-up.
 */
export const ALWAYS_ASK = [
  { key: 'passkey.manage', label: 'Adding or removing your passkeys' },
  { key: 'fresh.auth.passkey', label: 'Activating a protected-device exception (a passkey only)' },
  { key: 'confirm.relax', label: 'Turning a confirmation off in this section' },
] as const;
export type AlwaysAskKey = (typeof ALWAYS_ASK)[number]['key'];
export const ALWAYS_ASK_KEYS: readonly AlwaysAskKey[] = ALWAYS_ASK.map((f) => f.key);

/** Shown in the read-only note: what always asks, including what does not go through the step-up. */
export const ALWAYS_ASK_NOTE = [
  'Changing your own password (asks for your current password)',
  'Setting up or removing your authenticator (asks for a code)',
  ...ALWAYS_ASK.map((f) => f.label),
  'Confirming it is you itself (the step-up)',
] as const;

/** Any key a step-up site may name. */
export type StepUpKey = ConfirmKey | AlwaysAskKey;

/**
 * The seven 0.47 everyday actions. 0071 sets these to
 * `off` where 0.47's everyday setting was `off`; kept here only so the unit test can
 * check that mapping against the migration.
 */
export const LEGACY_ROUTINE_KEYS = [
  'actions.direct', 'scripts.direct', 'software.catalog', 'agent.migrate',
  'agent.autoupdate.computer', 'agent.autoupdate.business', 'patching.policy',
] as const satisfies readonly ConfirmKey[];
