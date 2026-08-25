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

  // Support
  QUICK_CONNECT: 'support:quick_connect',
  SESSIONS_VIEW: 'support:sessions_view',
  HISTORY_VIEW: 'support:history_view',

  // Users
  USERS_VIEW: 'users:view',
  USERS_MANAGE: 'users:manage',

  // Audit
  AUDIT_VIEW: 'audit:view',
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
    ],
  },
  {
    group: 'Support',
    items: [
      { key: CAP.QUICK_CONNECT, label: 'Use Quick Connect', description: 'Connect to a one-off computer using an ID and password the remote person reads out.' },
      { key: CAP.SESSIONS_VIEW, label: 'View active sessions', description: 'See sessions currently in progress.' },
      { key: CAP.HISTORY_VIEW, label: 'View session history', description: 'See past sessions for this business.' },
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
