'use client';

import { useQuery } from '@tanstack/react-query';
import { platformApi } from '@/lib/api-client';
import { usePermissions } from '@/lib/auth';
import { inkOn } from '@/lib/contrast';

/**
 * The platform branding the sidebar header is drawn with, and the ink that
 * is readable on its accent colour (0.35). Branding lives on the platform
 * record and is readable only by the operator; everyone else gets the
 * default mark (no accent, theme colours). One query key, so the sidebar and
 * the drawer's close button — which sits on that header — share one fetch
 * and never disagree about the colour behind it.
 */
export function useBrandAccent() {
  const { user, isPlatformAdmin } = usePermissions();
  const { data: platform } = useQuery({
    queryKey: ['platform', user?.tenantId],
    queryFn: () => platformApi.get(user!.tenantId!).then((r) => r.data?.data),
    enabled: !!user?.tenantId && isPlatformAdmin,
  });
  const branding = (platform as Record<string, unknown> | undefined)?.branding as Record<string, unknown> | null | undefined;
  const raw = branding?.accentColor as string | null | undefined;
  // An accent that is not a hex colour is not drawn at all, rather than drawn with a guessed ink.
  const ink = inkOn(raw);
  return {
    portalTitle: (branding?.portalTitle as string | null) || 'Rem0te',
    logoUrl: branding?.logoUrl as string | null | undefined,
    accentColor: ink ? raw! : null,
    /** '#000000' or '#ffffff' on the accent; null with no accent (use the theme's colours). */
    ink,
  };
}
