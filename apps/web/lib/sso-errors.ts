/**
 * What `?sso_error=<code>` means, in words a person can act on.
 *
 * The codes come from apps/api/src/sso (SsoError codes and the controller's
 * own `unavailable` / `account` / `failed`). The API deliberately never puts
 * provider detail in the redirect, so neither does this.
 */
const PASSWORD_THEN_LINK =
  'Sign in with your email and password, then link this provider from My Account → Single sign-on.';

const MESSAGES: Record<string, string> = {
  unavailable: 'That sign-in provider is not available right now. Try again later, or sign in with your password.',
  state_mismatch:
    'The sign-in could not be matched to this browser — it may have started in another tab or browser, or cookies are blocked. Start again from this page.',
  expired: 'That sign-in attempt took too long and has expired. Start again.',
  disabled: 'That sign-in provider has been turned off. Sign in with your password instead.',
  provider_error: 'The provider did not complete the sign-in (it may have been cancelled or refused). Try again.',
  exchange_failed: "The provider's response could not be verified, so you were not signed in. Try again, or ask an administrator to check the provider configuration.",
  not_linked: `No account is linked to that identity. ${PASSWORD_THEN_LINK}`,
  email_unverified: 'The provider did not supply a verified email address, so no account could be created. Ask an administrator for help.',
  email_in_use: `An account with that email address already exists, and accounts are never linked by email. ${PASSWORD_THEN_LINK}`,
  provisioned_no_access:
    'Your account was created, but it has no access yet. Ask an administrator to add you to a business, then sign in again.',
  account: 'Your account cannot sign in right now (it may be suspended or not fully set up). Ask an administrator for help.',
  linked_elsewhere: 'That identity is already linked to a different account here, so it was not linked to yours.',
  already_linked:
    'Your account is already linked to a different identity at that provider. Unlink it from My Account first, then link again.',
  failed: 'Single sign-on did not complete. Try again, or sign in with your password.',
  // 0.59
  org_mismatch: 'That identity is not in the organization this provider is bound to, so it cannot sign in here. Ask an administrator.',
  admin_not_allowed: 'Platform Admins cannot sign in through this provider. Sign in with your password and passkey.',
  admin_needs_passkey: 'A Platform Admin must sign in to this provider with a passkey or security key. Try again with one.',
  step_up_session_ended: 'Your session ended before the confirmation finished. Sign in again.',
  step_up_wrong_identity: 'The provider confirmed a different account from the one signed in here. Sign out of the provider and try again as yourself.',
  step_up_no_auth_time: 'The provider did not say when you signed in, so the confirmation could not be accepted. Ask an administrator to check the provider.',
  step_up_not_fresh: 'The provider did not ask you to sign in again, so the confirmation could not be accepted. Try again.',
  step_up_too_weak: 'The provider confirmed you with a weaker method than this needs (for example a password where a second factor or passkey is required). Try again with a stronger one.',
  step_up_passkey_not_trusted: 'This needs a passkey, and this provider is not trusted to confirm passkeys. Use a passkey registered here instead.',
};

/** 0.59: why a password or passkey sign-in was refused under "SSO required". */
export const SSO_REQUIRED_MESSAGE =
  'Your organization requires single sign-on. Use the sign-in provider button on this page.';

/** A friendly message for an `sso_error` (or `sso_step_up_error`) code, or null when there is none. */
export function ssoErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? MESSAGES.failed;
}
