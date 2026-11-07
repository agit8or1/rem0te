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
};

/** A friendly message for an `sso_error` code, or null when there is none. */
export function ssoErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? MESSAGES.failed;
}
