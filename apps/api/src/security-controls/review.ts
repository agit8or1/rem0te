import { ForbiddenException } from '@nestjs/common';
import type { ActorContext } from '../rbac/access-control.service';

/**
 * Independent review: the decider is someone other than the requester, and
 * is either a Platform Admin or a designated independent reviewer
 * (`approvals:review`). Holding a technician tier is never enough.
 *
 * A deployment with a single Platform Admin and no reviewer cannot approve a
 * widening at all. That is the point: the request stays pending and visible
 * until a second person exists.
 */
export function assertIndependentReviewer(actor: ActorContext, requesterId: string, what: string) {
  if (actor.technician) throw new ForbiddenException('Switch back to your own account context to review requests');
  if (actor.userId === requesterId) {
    throw new ForbiddenException({ code: 'NOT_INDEPENDENT', message: `You cannot approve your own ${what}. Another reviewer must decide it.` });
  }
  const reviewer = actor.isPlatformAdmin || (actor.platformPermissions ?? []).includes('approvals:review');
  if (!reviewer) throw new ForbiddenException({ code: 'NOT_A_REVIEWER', message: `Approving a ${what} needs a Platform Admin or a designated independent reviewer.` });
}

/** Fresh authentication, required whatever step-up actions are enabled. */
export function assertFresh(method: string | null, opts: { phishingResistant?: boolean } = {}) {
  if (!method) {
    throw new ForbiddenException({ code: 'STEP_UP_REQUIRED', action: 'fresh.auth', message: 'Confirm it is you to continue: this action always needs a fresh re-authentication.' });
  }
  if (opts.phishingResistant && method !== 'passkey') {
    throw new ForbiddenException({ code: 'STEP_UP_REQUIRED', action: 'fresh.auth.passkey', message: 'This action needs a fresh passkey confirmation (password and authenticator codes are not accepted).' });
  }
}
