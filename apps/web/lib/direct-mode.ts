import { formatDate } from '@/lib/utils';

/**
 * Direct mode (0.40), said the same way wherever an action, a patch ring, a
 * software ring or a script run is requested or shown. Whether it applies is
 * the approval signer's decision, set by its operator with its CLI; the
 * portal only reports what the signer answered (`approval` / `direct`).
 */
export const DIRECT_REQUEST_NOTE =
  'Direct mode is on for this customer (set by the approval signer’s operator): your request is signed at once, with no approval step, and runs when the device next checks in.';

/**
 * 0.62: the reason sent when a form hides its "Reason (shown to the approvers)"
 * field because the business is in direct mode and nobody approves. The API
 * and the signer still validate a reason; this one satisfies them.
 */
export const DIRECT_DEFAULT_REASON = 'Created in Rem0te (direct mode)';

export const DIRECT_TOAST = 'Approved automatically (direct mode). It runs when the device next checks in.';

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
  return 'This device refused a direct-mode plan: its agent is older than 0.40 and accepts only plans approved on the approval page. Update the agent on this device, then request it again.';
}

/**
 * An agent from before 0.42 installs only security, critical, rollup and
 * ordinary updates, and answers a driver or definition update with
 * excluded_classification. A 0.42 portal plans nothing else that reason could
 * be about, so it means the agent, not the update.
 */
export const OLD_AGENT_UPDATE_REFUSAL =
  'This device’s agent is older than 0.42 and does not install drivers or definition updates. Update the agent on this device (the Agent card), then install it again.';
export function oldAgentUpdateRefusal(reason: string | null | undefined): string | null {
  return reason === 'excluded_classification' ? OLD_AGENT_UPDATE_REFUSAL : null;
}
