import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * The unassigned pool (0.57, check-security-invariants §70).
 *
 * A computer is unassigned while it has no business or no tenant: it checked
 * in on its own, or through a deployment key in review mode, and nobody has
 * adopted it yet. Only a Platform Admin can see one. Until it is adopted it is
 * inspected, never acted on: nothing connects to it, no credential is
 * released, no plan, diagnostic, update, reinstall or chat reaches it, and its
 * heartbeat is handed no work (enrollment.service.ts). Every one of those
 * paths calls `assertAssigned` (or answers ENDPOINT_UNASSIGNED itself).
 */
export const ENDPOINT_UNASSIGNED = 'ENDPOINT_UNASSIGNED';

export const UNASSIGNED_MESSAGE =
  'This computer is not assigned to a business yet. Nothing can connect to it or act on it until a Platform Admin adopts it from Devices → Unassigned.';

/** The pool, as a `where`: no tenant, or no business. */
export const UNASSIGNED_WHERE: Prisma.EndpointWhereInput = { OR: [{ tenantId: null }, { customerId: null }] };

/** Both columns must be read: an endpoint whose business was deleted has a tenant and no business. */
export function isUnassigned(ep: { customerId: string | null; tenantId: string | null }): boolean {
  return !ep.customerId || !ep.tenantId;
}

/** Refuse a remote or action path on an unassigned computer. */
export function assertAssigned(ep: { customerId: string | null; tenantId: string | null }): void {
  if (isUnassigned(ep)) throw new ForbiddenException({ code: ENDPOINT_UNASSIGNED, message: UNASSIGNED_MESSAGE });
}
