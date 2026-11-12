import { RoleType } from '@prisma/client';

/**
 * Rem0te authorization vocabulary.
 *
 *   PLATFORM_ADMIN  →  everything, in every business
 *   BUSINESS_OWNER  →  every capability below, in their own business only
 *   BUSINESS_USER   →  exactly the capabilities the Business Owner granted
 *
 * Quick Connect is a capability, not a role. Holding `support:quick_connect`
 * is necessary but not sufficient — the platform master switch and the
 * business switch both have to be on as well (see QuickConnectService).
 */
export const CAP = {
  // Computers
  COMPUTERS_VIEW: 'computers:view',
  COMPUTERS_CONNECT: 'computers:connect',
  COMPUTERS_ADD: 'computers:add',
  COMPUTERS_REMOVE: 'computers:remove',
  COMPUTERS_EDIT: 'computers:edit',
  // Reading a managed computer's Windows event logs. Separate from
  // `computers:view` on purpose: the System and Security logs of somebody
  // else's machine are a different kind of access from a name and an online
  // dot, and plenty of people who should see the inventory should not see
  // every failed logon on it.
  COMPUTERS_EVENT_LOGS: 'computers:event_logs',

  // Support
  QUICK_CONNECT: 'support:quick_connect',
  SESSIONS_VIEW: 'support:sessions_view',
  HISTORY_VIEW: 'support:history_view',
  // Seeing and working the support-request queue (claim, hand off, close).
  SUPPORT_REQUESTS: 'support:requests',
  // Chat (0.34): starting a chat with the person at a computer, writing in it
  // and ending it. Reading a transcript needs only `computers:view` — it
  // belongs to the computer. Separate from `computers:connect` because a
  // message on someone's desktop under the business's name is a different
  // thing from a remote session, and not on by default for a Business User.
  CHAT_SEND: 'support:chat',

  // Users
  USERS_VIEW: 'users:view',
  USERS_MANAGE: 'users:manage',

  // Audit
  AUDIT_VIEW: 'audit:view',

  // Integration (contract ticket-rmm-v1). Lets a mapped ClientSt0r technician
  // submit read-only ticket analysis for this business and read its staff-only
  // findings. It confers nothing else — no session, no command, no approval.
  TICKET_ANALYSIS: 'integration:ticket_analysis',

  // Approved actions (v0.26). Lets a person REQUEST a catalog action on a
  // computer they can reach. It never approves anything: approval belongs to
  // people on the approval signer's roster, which is not a capability and is
  // not stored in this database.
  ACTIONS_REQUEST: 'actions:request',

  // Monitoring (v0.29). Seeing alerts for the computers you can already see,
  // and acknowledging or resolving them. Grants nothing on the computer.
  ALERTS_VIEW: 'monitoring:alerts',
  // Setting monitors and maintenance windows for this business. Who is
  // NOTIFIED is not this capability: notification destinations are set by a
  // Business Owner (or the MSP) with fresh authentication, because pointing
  // alerts somewhere is a way to read a business's machine names out.
  MONITORING_CONFIGURE: 'monitoring:configure',

  // Script library. Writing scripts and new versions, and submitting them for
  // review; and, separately, approving or rejecting someone else's version.
  // Neither runs anything: nothing in the library can (docs/script-library.md).
  // A technician needs these on a grant covering the whole business.
  SCRIPTS_AUTHOR: 'scripts:author',
  SCRIPTS_REVIEW: 'scripts:review',
} as const;

export type Capability = (typeof CAP)[keyof typeof CAP];

/** Every capability a business can hand out. A Business Owner holds all of them. */
export const ALL_BUSINESS_CAPABILITIES: Capability[] = Object.values(CAP);

/**
 * What a brand-new Business User starts with. Everything more
 * administrative than looking at and connecting to a computer is off until
 * the Business Owner turns it on.
 */
export const DEFAULT_BUSINESS_USER_CAPABILITIES: Capability[] = [
  CAP.COMPUTERS_VIEW,
  CAP.COMPUTERS_CONNECT,
];

/** UI grouping — drives the permission checkboxes on the Business Users screen. */
export const CAPABILITY_GROUPS: {
  group: string;
  items: { key: Capability; label: string; description: string }[];
}[] = [
  {
    group: 'Computers',
    items: [
      { key: CAP.COMPUTERS_VIEW, label: 'View computers', description: 'See the computers belonging to this business.' },
      { key: CAP.COMPUTERS_CONNECT, label: 'Remote connect', description: 'Start a remote session to a computer they can see.' },
      { key: CAP.COMPUTERS_ADD, label: 'Add computers', description: 'Create enrollment links and add new computers.' },
      { key: CAP.COMPUTERS_REMOVE, label: 'Remove/revoke computers', description: 'Archive computers and revoke their access.' },
      { key: CAP.COMPUTERS_EDIT, label: 'Rename/edit computers', description: 'Rename, tag and re-organise computers.' },
      { key: CAP.COMPUTERS_EVENT_LOGS, label: 'Read event logs', description: "Fetch Windows event log entries from a computer they can see, including the Security log." },
    ],
  },
  {
    group: 'Support',
    items: [
      { key: CAP.QUICK_CONNECT, label: 'Use Quick Connect', description: 'Connect to a one-off computer using an ID and password the remote person reads out.' },
      { key: CAP.SESSIONS_VIEW, label: 'View active sessions', description: 'See sessions currently in progress.' },
      { key: CAP.HISTORY_VIEW, label: 'View session history', description: 'See past sessions for this business.' },
      { key: CAP.SUPPORT_REQUESTS, label: 'Handle support requests', description: 'See the support request queue, claim requests, hand them off and close them.' },
      { key: CAP.CHAT_SEND, label: 'Chat with the person at a computer', description: "Open a chat window on a Windows computer they can see, write in it and end it. The window shows the business name and their own name. Anyone who can see the computer can read its transcripts." },
    ],
  },
  {
    group: 'Users',
    items: [
      { key: CAP.USERS_VIEW, label: 'View business users', description: 'See the other people in this business.' },
      { key: CAP.USERS_MANAGE, label: 'Manage business users', description: 'Invite, disable and remove business users, and set their permissions.' },
    ],
  },
  {
    group: 'Audit',
    items: [
      { key: CAP.AUDIT_VIEW, label: 'View business audit log', description: "See this business's audit history." },
    ],
  },
  {
    group: 'Integration',
    items: [
      { key: CAP.TICKET_ANALYSIS, label: 'Ticket analysis (ClientSt0r)', description: 'Submit read-only ticket analysis from ClientSt0r for this business and read the staff-only findings, and (with Rename/edit computers) ask ClientSt0r for a computer\'s AI summary from its redacted notes and sessions. Grants no remote access and no actions.' },
    ],
  },
  {
    group: 'Monitoring',
    items: [
      { key: CAP.ALERTS_VIEW, label: 'See and work alerts', description: 'See monitoring alerts for the computers they can see, and acknowledge or resolve them.' },
      { key: CAP.MONITORING_CONFIGURE, label: 'Configure monitoring', description: 'Add and change monitors and maintenance windows for this business. Who gets notified is set by a Business Owner.' },
    ],
  },
  {
    group: 'Actions',
    items: [
      { key: CAP.ACTIONS_REQUEST, label: 'Request approved actions', description: 'Ask for a catalog action (such as starting the Print Spooler) on a computer they can reach. Nothing runs until people on the approval roster approve it with their passkeys; this permission never approves.' },
    ],
  },
  {
    group: 'Automation',
    items: [
      { key: CAP.SCRIPTS_AUTHOR, label: 'Write scripts', description: "Add scripts to this business's library, edit them (each edit is a new version) and submit versions for review. Never approves a run." },
      { key: CAP.SCRIPTS_REVIEW, label: 'Review scripts', description: "Approve or reject someone else's script version. Never one they wrote or edited. Approving needs a fresh sign-in, and runs nothing; with this permission they can also propose an approved version to the approval signer's allowlist, which its own approvers decide." },
    ],
  },
];

/**
 * Legacy role → capability translation, applied by migration 0009 and by the
 * runtime fallback below for any membership that predates it.
 *
 * Least privilege is the rule: an old Read Only user must NOT come out of the
 * migration able to start a remote session, and an old Billing Admin — who
 * never had `endpoints:read` — gets no computer capabilities at all.
 */
export const LEGACY_ROLE_CAPABILITIES: Partial<Record<RoleType, Capability[]>> = {
  TECHNICIAN: [CAP.COMPUTERS_VIEW, CAP.COMPUTERS_CONNECT, CAP.SESSIONS_VIEW, CAP.HISTORY_VIEW],
  BILLING_ADMIN: [CAP.USERS_VIEW, CAP.AUDIT_VIEW],
  READ_ONLY: [CAP.COMPUTERS_VIEW, CAP.SESSIONS_VIEW, CAP.HISTORY_VIEW, CAP.AUDIT_VIEW],
  CUSTOMER: [CAP.COMPUTERS_VIEW, CAP.COMPUTERS_CONNECT, CAP.SESSIONS_VIEW, CAP.HISTORY_VIEW],
};

/** Legacy role types that migration 0009 folds into BUSINESS_OWNER. */
export const LEGACY_OWNER_ROLES: RoleType[] = [RoleType.TENANT_OWNER, RoleType.TENANT_ADMIN];

export function isOwnerRole(roleType: RoleType | null | undefined): boolean {
  if (!roleType) return false;
  return roleType === RoleType.BUSINESS_OWNER || LEGACY_OWNER_ROLES.includes(roleType);
}

/**
 * What a technician assignment may grant inside a customer business.
 *
 * Everything except `users:manage`: administering who in the customer's own
 * business has access is the customer's job (and Business Owner's), and an
 * MSP technician who could edit the business's users could also hand
 * themselves — or anyone in that business — access the assignment never gave.
 */
export const TECHNICIAN_ASSIGNABLE_CAPABILITIES: Capability[] =
  ALL_BUSINESS_CAPABILITIES.filter((c) => c !== CAP.USERS_MANAGE);

export function sanitizeTechnicianCapabilities(input: unknown): Capability[] {
  const allowed = new Set<string>(TECHNICIAN_ASSIGNABLE_CAPABILITIES);
  return sanitizeCapabilities(input).filter((c) => allowed.has(c));
}

/** Reject anything that is not a known capability before it reaches the database. */
export function sanitizeCapabilities(input: unknown): Capability[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<string>(ALL_BUSINESS_CAPABILITIES);
  const out = new Set<Capability>();
  for (const raw of input) {
    if (typeof raw === 'string' && allowed.has(raw)) out.add(raw as Capability);
  }
  return [...out];
}

/**
 * The authoritative capability set for an actor.
 *
 * Platform Admin and Business Owner are computed, never stored — so revoking
 * a capability can never leave a stale grant behind on an owner's row.
 */
export function effectiveCapabilities(actor: {
  isPlatformAdmin?: boolean;
  roleType?: RoleType | null;
  capabilities?: string[] | null;
}): Capability[] {
  if (actor.isPlatformAdmin) return ALL_BUSINESS_CAPABILITIES;
  if (isOwnerRole(actor.roleType)) return ALL_BUSINESS_CAPABILITIES;

  const stored = sanitizeCapabilities(actor.capabilities);
  if (stored.length > 0) return stored;

  // Fallback for a membership that has not been through migration 0009 —
  // translate on read rather than silently granting nothing.
  return actor.roleType ? (LEGACY_ROLE_CAPABILITIES[actor.roleType] ?? []) : [];
}

export function hasCapability(
  actor: { isPlatformAdmin?: boolean; roleType?: RoleType | null; capabilities?: string[] | null },
  capability: Capability,
): boolean {
  if (actor.isPlatformAdmin) return true;
  return effectiveCapabilities(actor).includes(capability);
}

/** Human-facing name for the three levels. Used by the API and the UI alike. */
export function accessLevelLabel(actor: {
  isPlatformAdmin?: boolean;
  roleType?: RoleType | null;
}): 'Platform Admin' | 'Business Owner' | 'Business User' {
  if (actor.isPlatformAdmin) return 'Platform Admin';
  if (isOwnerRole(actor.roleType)) return 'Business Owner';
  return 'Business User';
}
