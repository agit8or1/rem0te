import type { Response } from 'express';

/** The session cookies, shared by every sign-in method so they cannot drift. */
const secure = () => process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true';

export function setAccessCookie(res: Response, token: string) {
  res.cookie('access_token', token, { httpOnly: true, secure: secure(), sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000, path: '/' });
}

export function setPartialCookie(res: Response, token: string) {
  res.cookie('partial_token', token, { httpOnly: true, secure: secure(), sameSite: 'strict', maxAge: 10 * 60 * 1000, path: '/' });
}

/**
 * Binds an OIDC round trip to the browser that started it. SameSite=Lax, not
 * strict: the provider's redirect back is a cross-site top-level navigation,
 * which a strict cookie is not sent on.
 */
export const SSO_STATE_COOKIE = 'sso_state';
export function setSsoStateCookie(res: Response, state: string) {
  res.cookie(SSO_STATE_COOKIE, state, { httpOnly: true, secure: secure(), sameSite: 'lax', maxAge: 10 * 60 * 1000, path: '/api/v1/auth/sso' });
}
export function clearSsoStateCookie(res: Response) {
  res.clearCookie(SSO_STATE_COOKIE, { path: '/api/v1/auth/sso' });
}

/** A same-origin path to land on after sign-in; anything else becomes the dashboard. */
export function safeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || v.length > 300) return '/dashboard';
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || /[\r\n]/.test(v)) return '/dashboard';
  return v;
}
