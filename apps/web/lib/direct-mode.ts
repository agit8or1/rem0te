import { formatDate } from '@/lib/utils';

/**
 * Direct mode (0.40), said the same way wherever an action, a patch ring, a
 * software ring or a script run is requested or shown. Whether it applies is
 * the approval signer's decision, set by its operator with its CLI; the
 * portal only reports what the signer answered (`approval` / `direct`).
 */
export const DIRECT_REQUEST_NOTE =
  'Direct mode is on for this business (set by the approval signer’s operator): your request is signed at once, with no approval step, and runs when the computer next checks in. You will be asked to confirm it is you.';

export const DIRECT_TOAST = 'Approved automatically (direct mode). It runs when the computer next checks in.';

/** "Approved automatically (direct mode) by Dana, 13 Nov 2026 20:01". */
export function directApproved(by: string | null | undefined, at: string | Date): string {
  return `Approved automatically (direct mode) by ${by || 'the requester'}, ${formatDate(typeof at === 'string' ? at : at.toISOString())}`;
}

/**
 * An agent from before 0.40 answers a direct plan with bad_plan: it cannot
 * parse the signed approval field, and refuses rather than run it.
 */
export function oldAgentRefusal(direct: boolean | undefined, reason: string | null | undefined): string | null {
  if (!direct || reason !== 'bad_plan') return null;
  return 'This computer refused a direct-mode plan: its agent is older than 0.40 and accepts only plans approved on the approval page. Update the agent on this computer, then request it again.';
}
