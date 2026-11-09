/**
 * Platform-level permissions that are NOT Platform Admin.
 *
 * Platform Admin is all-or-nothing: every business, infrastructure settings,
 * server updates, security configuration. An MSP that wants a dispatcher who
 * can put technicians on customer businesses should not have to hand them the
 * server as well, so that one job is its own permission, stored on
 * `User.platformPermissions` and re-read from the database on every request.
 *
 * Holding `technicians:manage` grants NO access to any business by itself —
 * it is the right to create assignments (which are audited), not a bypass.
 * Platform Admins hold every platform permission implicitly.
 */
export const PLATFORM_PERM = {
  TECHNICIANS_MANAGE: 'technicians:manage',
  // v0.23: designated independent reviewer. May approve another person's
  // temporary-access request, maintenance exception or trust change — never
  // their own. Separate from any technician tier: an L3 preset alone grants
  // no approval. Granting it widens trust, so it needs independent review.
  APPROVALS_REVIEW: 'approvals:review',
} as const;

export type PlatformPermission = (typeof PLATFORM_PERM)[keyof typeof PLATFORM_PERM];

export const ALL_PLATFORM_PERMISSIONS: PlatformPermission[] = Object.values(PLATFORM_PERM);

export const PLATFORM_PERMISSION_LABELS: Record<PlatformPermission, { label: string; description: string }> = {
  'technicians:manage': {
    label: 'Manage technician access',
    description:
      'Create technician groups and assign MSP staff to customer businesses (including temporary contractor access). ' +
      'Does not grant access to any business by itself and does not include infrastructure or platform settings.',
  },
  'approvals:review': {
    label: 'Independent reviewer',
    description:
      "Approve someone else's temporary control, protected-device exception, maintenance exception or trust change. " +
      'Never their own. Grants no access to any business and no ability to act on a computer.',
  },
};

export function sanitizePlatformPermissions(input: unknown): PlatformPermission[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<string>(ALL_PLATFORM_PERMISSIONS);
  return [...new Set(input.filter((p): p is PlatformPermission => typeof p === 'string' && allowed.has(p)))];
}
