-- Additional audit event types introduced as part of the security hardening pass.
-- ALTER TYPE ... ADD VALUE is idempotent-safe with IF NOT EXISTS on PG 12+.
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'NOTE_COMMENT_ADDED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'ENDPOINT_PASSWORD_REVEALED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'RECOVERY_CODE_BLOCKED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'RECOVERY_CODE_LOCKOUT';
