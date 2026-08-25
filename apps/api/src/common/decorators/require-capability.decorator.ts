import { SetMetadata } from '@nestjs/common';
import type { Capability } from '../../rbac/capabilities';

export const CAPABILITIES_KEY = 'capabilities';

/**
 * Require one or more business capabilities on a route.
 *
 * Platform Admin always passes. Business Owner always passes (they hold every
 * business capability). A Business User passes only if every listed capability
 * is on their membership.
 *
 * This gates the *verb*. It does not decide *which* business the caller may
 * act on — that is AccessControlService.resolveScope(), which every
 * business-scoped handler must also call.
 */
export const RequireCapability = (...capabilities: Capability[]) =>
  SetMetadata(CAPABILITIES_KEY, capabilities);
