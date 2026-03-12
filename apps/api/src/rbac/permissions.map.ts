import { RoleType } from '@prisma/client';

export const SYSTEM_ROLE_PERMISSIONS: Record<RoleType, string[]> = {
  [RoleType.PLATFORM_ADMIN]: ['*'],

  [RoleType.TENANT_OWNER]: [
    'dashboard:read',
    'platform:read',
    'tenant:read', 'tenant:write',
    'users:read', 'users:write',
    'roles:read', 'roles:write',
    'customers:read', 'customers:write',
    'endpoints:read', 'endpoints:write',
    'sessions:read', 'sessions:write',
    'notes:read', 'notes:write',
    'branding:write',
    'settings:write',
    'audit:read',
    'api_keys:read', 'api_keys:write',
  ],

  [RoleType.TENANT_ADMIN]: [
    'dashboard:read',
    'tenant:read',
    'users:read', 'users:write',
    'roles:read',
    'customers:read', 'customers:write',
    'endpoints:read', 'endpoints:write',
    'sessions:read', 'sessions:write',
    'notes:read', 'notes:write',
    'audit:read',
    'api_keys:read',
  ],

  [RoleType.TECHNICIAN]: [
    'dashboard:read',
    'customers:read',
    'endpoints:read',
    'sessions:read', 'sessions:write',
    'notes:read', 'notes:write',
  ],

  [RoleType.BILLING_ADMIN]: [
    'dashboard:read',
    'users:read',
    'audit:read',
    'api_keys:read', 'api_keys:write',
  ],

  [RoleType.READ_ONLY]: [
    'dashboard:read',
    'customers:read',
    'endpoints:read',
    'sessions:read',
    'notes:read',
    'audit:read',
  ],

  [RoleType.CUSTOMER]: [
    'portal:read',
    'endpoints:read',
    'sessions:read',
    'sessions:write',
  ],
};

export function roleHasPermission(roleType: RoleType, permission: string): boolean {
  const perms = SYSTEM_ROLE_PERMISSIONS[roleType] ?? [];
  if (perms.includes('*')) return true;
  if (perms.includes(permission)) return true;
  const [resource, action] = permission.split(':');
  if (perms.includes(`${resource}:*`)) return true;
  // :write covers :create, :update, :delete, :launch
  if (['create', 'update', 'delete', 'launch'].includes(action) && perms.includes(`${resource}:write`)) {
    return true;
  }
  return false;
}
