import { RoleType } from '@prisma/client';
import { CAP, Capability, effectiveCapabilities, isOwnerRole } from './capabilities';

/**
 * Bridge between the legacy `resource:action` permission strings still used by
 * `@RequirePermissions()` decorators and the three-level capability model.
 *
 * Rather than touch every decorator in one sweep (and risk quietly opening a
 * route), each legacy permission is classified once, here:
 *
 *   PLATFORM_ONLY  only a Platform Admin may pass
 *   OWNER_ONLY     Platform Admin or Business Owner
 *   MEMBER         any active member of a business
 *   <Capability>   a Business User needs that capability
 */
type PermissionRule = 'PLATFORM_ONLY' | 'OWNER_ONLY' | 'MEMBER' | Capability;

export const PERMISSION_RULES: Record<string, PermissionRule> = {
  // Platform-level
  'platform:admin': 'PLATFORM_ONLY',
  'platform:read': 'PLATFORM_ONLY',

  // Business profile / settings
  'tenant:read': 'MEMBER',
  'tenant:write': 'OWNER_ONLY',
  'settings:write': 'OWNER_ONLY',
  'branding:write': 'OWNER_ONLY',
  'customers:read': CAP.COMPUTERS_VIEW,
  'customers:write': 'OWNER_ONLY',

  // Dashboard / portal — visible to anyone with a business
  'dashboard:read': 'MEMBER',
  'portal:read': 'MEMBER',

  // Computers
  'endpoints:read': CAP.COMPUTERS_VIEW,
  'endpoints:write': CAP.COMPUTERS_EDIT,
  'endpoints:update': CAP.COMPUTERS_EDIT,
  'endpoints:create': CAP.COMPUTERS_ADD,
  'endpoints:delete': CAP.COMPUTERS_REMOVE,

  // Sessions / remote connections
  'sessions:read': CAP.SESSIONS_VIEW,
  'sessions:write': CAP.COMPUTERS_CONNECT,
  'sessions:create': CAP.COMPUTERS_CONNECT,
  'sessions:update': CAP.COMPUTERS_CONNECT,
  'sessions:launch': CAP.COMPUTERS_CONNECT,

  // Notes
  'notes:read': CAP.COMPUTERS_VIEW,
  'notes:write': CAP.COMPUTERS_EDIT,

  // Users & roles
  'users:read': CAP.USERS_VIEW,
  'users:write': CAP.USERS_MANAGE,
  'roles:read': CAP.USERS_VIEW,
  'roles:write': CAP.USERS_MANAGE,

  // Audit
  'audit:read': CAP.AUDIT_VIEW,

  // API keys are a business-integration surface — owner only.
  'api_keys:read': 'OWNER_ONLY',
  'api_keys:write': 'OWNER_ONLY',
};

/**
 * Evaluate one legacy permission string for an actor.
 * Unknown permissions fail closed.
 */
export function actorHasPermission(
  actor: {
    isPlatformAdmin?: boolean;
    roleType?: RoleType | null;
    capabilities?: string[] | null;
    businessId?: string | null;
  },
  permission: string,
): boolean {
  if (actor.isPlatformAdmin) return true;

  const rule = PERMISSION_RULES[permission] ?? resolveWildcard(permission);
  if (!rule) return false;

  if (rule === 'PLATFORM_ONLY') return false;

  const owner = isOwnerRole(actor.roleType);
  if (rule === 'OWNER_ONLY') return owner;
  if (rule === 'MEMBER') return owner || !!actor.roleType;

  if (owner) return true;
  return effectiveCapabilities(actor).includes(rule);
}

/**
 * `:write` historically covered create/update/delete/launch. Preserve that so
 * a decorator naming an action we did not enumerate still resolves.
 */
function resolveWildcard(permission: string): PermissionRule | null {
  const [resource, action] = permission.split(':');
  if (!resource || !action) return null;
  if (['create', 'update', 'delete', 'launch'].includes(action)) {
    return PERMISSION_RULES[`${resource}:write`] ?? null;
  }
  return null;
}

// ── Legacy surface, retained for the migration window ────────────────────────
//
// SYSTEM_ROLE_PERMISSIONS described the seven-role hierarchy. It is no longer
// consulted for authorization — actorHasPermission() is — but the seed script
// and the 0009 migration reference the old shapes, so the map stays until the
// legacy Role rows are dropped in a later release.

export const SYSTEM_ROLE_PERMISSIONS: Partial<Record<RoleType, string[]>> = {
  [RoleType.PLATFORM_ADMIN]: ['*'],
  [RoleType.BUSINESS_OWNER]: Object.keys(PERMISSION_RULES).filter(
    (p) => PERMISSION_RULES[p] !== 'PLATFORM_ONLY',
  ),
  [RoleType.BUSINESS_USER]: ['dashboard:read', 'endpoints:read', 'sessions:create'],
};

export function roleHasPermission(roleType: RoleType, permission: string): boolean {
  return actorHasPermission({ roleType, capabilities: null }, permission);
}
