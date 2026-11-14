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
export function assertFresh(method: string | null, opts: { phishingResistant?: boolean; action?: string; message?: string; routine?: RoutineAction } = {}) {
  // 0.46.1: an everyday change asks only when the platform setting says so.
  if (opts.routine && !routineConfirmRequired()) return;
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

/**
 * Everyday changes (0.46.1). The owner runs the portal alone and was asked to
 * confirm it was them on every software install, uninstall, service change
 * and process end. With `PlatformSettings.routineConfirm` = 'off' (the
 * default), these ask nothing beyond the signed-in session and its MFA; with
 * 'every' they ask, and the confirmation lasts 10 minutes (STEP_UP_TTL_MS).
 *
 * This is a closed list. Anything not on it always asks, whatever the setting:
 * security controls, presets, credentials, permissions, API keys, passkeys,
 * enrolment links, containment, notification destinations, email relay,
 * chat recording, and the fleet-wide automatic update and migration switches.
 */
export const ROUTINE_ACTIONS = [
  'actions.direct',            // a direct-mode action request (computer actions, patches, software, services, processes)
  'scripts.direct',            // a direct-mode script allowlist proposal
  'software.catalog',          // adding, changing or archiving a software catalog entry
  'agent.migrate',             // upgrading a computer, or a selection, to the full agent
  'agent.autoupdate.computer', // one computer's automatic agent updates
  'agent.autoupdate.business', // one business's automatic agent updates
  'patching.policy',           // creating or revoking a patch policy
] as const;
export type RoutineAction = (typeof ROUTINE_ACTIONS)[number];
export type RoutineConfirm = 'off' | 'every';

// Fails closed: until the setting has been read from the database, ask.
let routineSetting: RoutineConfirm = 'every';
let routineLoaded = false;

/** Set by RoutineConfirmService when it reads or changes the setting. */
export function setRoutineConfirm(v: unknown): void {
  routineSetting = v === 'off' ? 'off' : 'every';
  routineLoaded = true;
}

/** Whether an everyday change must ask; true until the setting is known. */
export function routineConfirmRequired(): boolean {
  return !routineLoaded || routineSetting !== 'off';
}
