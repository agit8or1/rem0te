-- Session revocation and TOTP replay protection (security audit, 0.18.22).
--
-- A session JWT stayed valid for its full eight hours whatever happened to
-- the account: signing out only cleared the cookie, and changing a password
-- left every other copy of the old token working. `sessionsValidAfter` is the
-- revocation point the JWT strategy compares each token's `iat` against.
--
-- A TOTP code was accepted any number of times within its validity window.
-- `lastTotpStep` records the time step of the last accepted code; a code at
-- or before it is refused.
ALTER TABLE "User" ADD COLUMN "sessionsValidAfter" TIMESTAMP(3);
ALTER TABLE "UserMfaMethod" ADD COLUMN "lastTotpStep" INTEGER;
