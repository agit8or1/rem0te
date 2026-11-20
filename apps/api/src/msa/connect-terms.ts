/**
 * What a Managed Secure Access Connect grant allows (0.73, build step 5,
 * docs/managed-secure-access.md §3.2–3.3). Pure: types and one function.
 *
 * The launch policy (AccessPolicyService.evaluateLaunch, through
 * EndpointsService.authorizeConnect) has already said yes, and how: the
 * path (member, legacy assignment, preset), the session limit, and the
 * effective access controls. This turns that decision into a grant's mode,
 * permissions, consent and limits. Nothing a technician sends reaches it but
 * the launch mode they asked for, which the policy has already decided on:
 *
 *   - mode: view_only → view; control and unattended → control. Elevated
 *     never gets here (the policy refuses it everywhere).
 *   - consent: required for a preset technician when the access controls
 *     require attended consent — exactly when a Legacy launch is refused
 *     today with endpoint_cannot_enforce_consent; on a managed computer
 *     RustDesk enforces it (approve-mode=click). Members and Platform Admins
 *     keep what they had: consent is not applied to them.
 *   - permissions: none for view. For control, clipboard and file transfer
 *     only when the access controls allow them (`request`) AND, for a preset
 *     technician, a covering preset allows them; audio with control; tunnel
 *     and remote restart never (the managed ceiling, msa/managed.ts).
 *   - limits: the policy's session limit (the preset's, or the access
 *     controls' maxSessionMinutes for everyone else — advisory on Legacy,
 *     enforced by the agent here), 1–480; idle disconnect at 15 minutes or
 *     the session limit if shorter.
 */
import type { GrantConsent, GrantMode, GrantPermissions } from './grant';
import { MANAGED_CEILING, withinCeiling } from './managed';

export type ManagedLaunchMode = 'view_only' | 'control' | 'unattended';
export const MANAGED_LAUNCH_MODES: readonly ManagedLaunchMode[] = ['view_only', 'control', 'unattended'];

export interface TermsInput {
  mode: ManagedLaunchMode;
  path: 'member' | 'legacy_assignment' | 'preset';
  /** The policy's session limit for this launch (a preset's); null for members, Platform Admins and custom assignments. */
  maxSessionMinutes: number | null;
  controls: { attendedConsent: 'required' | 'not_required'; clipboard: 'off' | 'request'; fileTransfer: 'off' | 'request'; maxSessionMinutes: number };
  /** A covering preset allows clipboard / file transfer (`allowed`). Ignored off the preset path. */
  presetClipboard: boolean;
  presetFiles: boolean;
}

export interface GrantTerms {
  mode: GrantMode;
  permissions: GrantPermissions;
  consent: GrantConsent;
  maxMinutes: number;
  idleMinutes: number;
}

export const IDLE_MINUTES_DEFAULT = 15;

export function managedGrantTerms(i: TermsInput): GrantTerms {
  const mode: GrantMode = i.mode === 'view_only' ? 'view' : 'control';
  const preset = i.path === 'preset';
  const control = mode === 'control';
  const permissions: GrantPermissions = {
    clipboard: control && i.controls.clipboard === 'request' && (!preset || i.presetClipboard) && MANAGED_CEILING.permissions.clipboard,
    files: control && i.controls.fileTransfer === 'request' && (!preset || i.presetFiles) && MANAGED_CEILING.permissions.files,
    audio: control && MANAGED_CEILING.permissions.audio,
    tunnel: false,
    restart: false,
  };
  const consent: GrantConsent = preset && i.controls.attendedConsent === 'required' ? 'required' : 'not_required';
  const limit = i.maxSessionMinutes ?? i.controls.maxSessionMinutes;
  const maxMinutes = Math.max(1, Math.min(480, Math.floor(limit)));
  const idleMinutes = Math.min(IDLE_MINUTES_DEFAULT, maxMinutes);
  if (!withinCeiling(mode, permissions)) throw new Error('managed grant terms above the ceiling');
  return { mode, permissions, consent, maxMinutes, idleMinutes };
}
