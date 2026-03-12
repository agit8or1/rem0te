'use client';

import { useQuery } from '@tanstack/react-query';
import { authApi } from './api-client';

export interface CurrentUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  isPlatformAdmin: boolean;
  tenantId: string | null;
  roleType: string | null;
  mfaVerified: boolean;
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
