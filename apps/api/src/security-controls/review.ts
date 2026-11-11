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

/**
 * Fresh authentication, required whatever step-up actions are enabled.
 *
 * `action` names what is being confirmed, so the console's dialog can say it
 * (default `fresh.auth`). It changes the wording only, never the rule.
 */
export function assertFresh(method: string | null, opts: { phishingResistant?: boolean; action?: string; message?: string } = {}) {
  if (!method) {
    throw new ForbiddenException({
      code: 'STEP_UP_REQUIRED', action: opts.action ?? 'fresh.auth',
      message: opts.message ?? 'Confirm it is you to continue: this action always needs a fresh re-authentication.',
    });
  }
  if (opts.phishingResistant && method !== 'passkey') {
    throw new ForbiddenException({ code: 'STEP_UP_REQUIRED', action: 'fresh.auth.passkey', message: 'This action needs a fresh passkey confirmation (password and authenticator codes are not accepted).' });
  }
}
