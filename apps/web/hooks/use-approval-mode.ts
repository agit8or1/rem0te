'use client';

import { useQuery } from '@tanstack/react-query';
import { actionsApi } from '@/lib/api-client';

/**
 * 0.40.1: the approval signer's mode for a computer's business, or for one
 * business, read only (GET /actions/catalog). `direct` means a request is
 * signed at once after a fresh sign-in; `signed` means two approvers on the
 * roster; `null` means no signer, or it could not be asked.
 *
 * The pages use it only for their words. Whether a request is signed at once
 * is still decided by the signer, and the response says which happened.
 */
export function useApprovalMode(target: { endpointId?: string; businessId?: string }): 'direct' | 'signed' | null | undefined {
  const { endpointId, businessId } = target;
  const { data } = useQuery({
    queryKey: endpointId ? ['actions-catalog', endpointId] : ['actions-catalog-business', businessId],
    enabled: !!(endpointId || businessId),
    queryFn: () => actionsApi.catalog(endpointId, businessId).then((r) => r.data.data as { approval: 'direct' | 'signed' | null }),
  });
  return data?.approval;
}
