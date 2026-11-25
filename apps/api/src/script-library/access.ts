import type { Prisma } from '@prisma/client';
import type { ActorContext } from '../rbac/access-control.service';
import { CAP, type Capability } from '../rbac/capabilities';
import { PLATFORM_PERM } from '../rbac/platform-permissions';

/**
 * Who may see which script (0.87, extracted from ScriptLibraryService).
 *
 * Pure: no database, no Nest. The library's own list, its detail reads,
 * global search (search/search.service.ts) and favourites
 * (navigation/navigation.service.ts) all decide visibility with these same
 * functions, so a script can never be found or named somewhere it could not
 * be opened. This file is the only part of the library another module may
 * import (§23, §96): it reads nothing and can change nothing.
 */

export type ScriptView = 'full' | 'approved_only';

/**
 * A library capability in the business this request acts in. A technician
 * needs it on a grant covering the WHOLE business: a script is not scoped
 * to a computer, so a grant naming computers confers no library rights.
 */
export function hasBusinessCap(actor: ActorContext, cap: Capability): boolean {
  if (actor.isPlatformAdmin) return true;
  if (!actor.businessId) return false;
  if (actor.technician) {
    return actor.technician.businessId === actor.businessId
      && actor.technician.sources.some((s) => s.endpointIds === null && (s.capabilities as string[]).includes(cap));
  }
  return actor.capabilities.includes(cap);
}

export function platformReviewer(actor: ActorContext): boolean {
  return actor.isPlatformAdmin || (actor.platformPermissions ?? []).includes(PLATFORM_PERM.APPROVALS_REVIEW);
}

/** Any right in the library at all: without one, the list route refuses. */
export function anyRight(actor: ActorContext): boolean {
  return platformReviewer(actor) || hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || hasBusinessCap(actor, CAP.SCRIPTS_REVIEW);
}

/** How much of a script this person may see, or null (then it is a 404). */
export function viewOf(actor: ActorContext, s: { scope: string; customerId: string | null }): ScriptView | null {
  if (s.scope === 'GLOBAL') {
    if (platformReviewer(actor)) return 'full';
    // A business's authors and reviewers see the global scripts that have
    // been approved, as reference. Never their drafts.
    return hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || hasBusinessCap(actor, CAP.SCRIPTS_REVIEW) ? 'approved_only' : null;
  }
  if (actor.isPlatformAdmin) return 'full';
  if (!actor.businessId || s.customerId !== actor.businessId) return null;
  return hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || hasBusinessCap(actor, CAP.SCRIPTS_REVIEW) ? 'full' : null;
}

/**
 * The list's candidate rows: global scripts, and the scoped business's when
 * the caller has a library right there. `viewOf` is still applied to every
 * row afterwards; this only keeps the query small. `scope` is the business
 * the list is narrowed to (a Platform Admin may name one or none).
 */
export function libraryWhere(actor: ActorContext, scope: string | null): Prisma.ScriptWhereInput {
  const bizVisible = !!scope && (actor.isPlatformAdmin || hasBusinessCap(actor, CAP.SCRIPTS_AUTHOR) || hasBusinessCap(actor, CAP.SCRIPTS_REVIEW));
  return actor.isPlatformAdmin && !scope
    ? {}
    : { OR: [{ scope: 'GLOBAL' }, ...(bizVisible ? [{ customerId: scope! }] : [])] };
}

/** The business a non-admin's list is scoped to: always their own. */
export function listScope(actor: ActorContext, businessId?: string): string | null {
  return actor.isPlatformAdmin ? (businessId?.trim() || null) : (actor.businessId ?? null);
}
