/**
 * Session revocation, in one place, because JWT time is in whole seconds.
 *
 * `User.sessionsValidAfter` is compared against each token's `iat`, which is
 * floor(seconds). Revoking at the exact current instant left every token
 * minted earlier in that same second valid — a sign-out followed within the
 * second by a request with the old cookie still worked. So the revocation
 * point is rounded UP to the next whole second, and any token minted after a
 * revocation is stamped with an `iat` no earlier than it, so a sign-in in the
 * same second as a sign-out is not refused as if it predated it.
 */
export function revocationInstant(now = Date.now()): Date {
  return new Date(Math.ceil(now / 1000) * 1000);
}

export function isRevoked(iat: number | undefined, validAfter: Date | null | undefined): boolean {
  return !!validAfter && (iat ?? 0) * 1000 < validAfter.getTime();
}

/** The `iat` to mint a token with, given the account's revocation point. */
export function issueAt(validAfter: Date | null | undefined, now = Date.now()): number {
  const nowSec = Math.floor(now / 1000);
  return validAfter ? Math.max(nowSec, Math.ceil(validAfter.getTime() / 1000)) : nowSec;
}
