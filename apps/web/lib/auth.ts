'use client';

import { useQuery } from '@tanstack/react-query';
import { authApi } from './api-client';

/**
 * The three access levels. There are no others.
 *
 *   Platform Admin  →  the Rem0te operator: every business, every setting
 *   Business Owner  →  full control of ONE business
 *   Business User   →  only the permissions the Business Owner granted
 */
export type AccessLevel = 'Platform Admin' | 'Business Owner' | 'Business User';

/** Capability keys. Kept in step with apps/api/src/rbac/capabilities.ts. */
export const CAP = {
  COMPUTERS_VIEW: 'computers:view',
  COMPUTERS_CONNECT: 'computers:connect',
  COMPUTERS_ADD: 'computers:add',
  COMPUTERS_REMOVE: 'computers:remove',
  COMPUTERS_EDIT: 'computers:edit',
  QUICK_CONNECT: 'support:quick_connect',
  SESSIONS_VIEW: 'support:sessions_view',
  HISTORY_VIEW: 'support:history_view',
  USERS_VIEW: 'users:view',
  USERS_MANAGE: 'users:manage',
  AUDIT_VIEW: 'audit:view',
} as const;

export type Capability = (typeof CAP)[keyof typeof CAP];

export interface CurrentUser {
  id: string;
  email: string;
  isPlatformAdmin: boolean;
  roleType: string | null;
  accessLevel: AccessLevel;
  businessId: string | null;
  business: { id: string; name: string; isActive: boolean; quickConnectEnabled: boolean } | null;
  /** Effective capabilities — a Business Owner already has the full set here. */
  capabilities: Capability[];
  tenantId: string | null;
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    const res = await authApi.me();
    return res.data?.data ?? null;
  } catch {
    return null;
  }
}

export function useCurrentUser() {
  return useQuery<CurrentUser | null>({
    queryKey: ['auth', 'me'],
    queryFn: getCurrentUser,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * What this user can do, for rendering decisions only.
 *
 * Hiding a button is a courtesy, not a control — the server re-checks every
 * capability and every business boundary on each request, so a user who
 * forges a URL gets a 403/404 regardless of what the UI showed them.
 */
export function usePermissions() {
  const { data: user, isLoading } = useCurrentUser();

  const capabilities = user?.capabilities ?? [];
  const can = (cap: Capability) => !!user && (user.isPlatformAdmin || capabilities.includes(cap));

  return {
    user,
    isLoading,
    can,
    isPlatformAdmin: !!user?.isPlatformAdmin,
    isBusinessOwner: user?.accessLevel === 'Business Owner' || !!user?.isPlatformAdmin,
    accessLevel: user?.accessLevel ?? null,
    businessId: user?.businessId ?? null,
    businessName: user?.business?.name ?? null,
  };
}
