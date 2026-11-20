-- 0.74 Server security (Admin → Security). Two audit actions:
--   HOST_SECURITY_CHANGED  every change the page makes to this host: a fail2ban
--                          ban, unban, never-ban entry or jail setting, installing
--                          fail2ban, and an OS upgrade (started and finished).
--                          Before 0.74 none of these left an audit row.
--   LOGIN_POLICY_CHANGED   the sign-in lockout policy, before and after, and
--                          clearing the stored, never-enforced GeoIP and IP rules.
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'HOST_SECURITY_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'LOGIN_POLICY_CHANGED';
