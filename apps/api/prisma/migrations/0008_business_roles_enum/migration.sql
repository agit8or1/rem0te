-- ════════════════════════════════════════════════════════════════════════════
-- 0008 — Three-level business access model (enum values only)
--
-- Split from 0009 on purpose: PostgreSQL will not let a newly added enum
-- value be USED in the same transaction that added it, and Prisma runs each
-- migration file in one transaction. 0009 does the data remap.
--
-- Replaces the seven-role hierarchy (Platform Admin / Tenant Owner /
-- Tenant Admin / Technician / Billing Admin / Read Only / Customer Portal)
-- with exactly three levels:
--
--     PLATFORM_ADMIN  →  the Rem0te operator
--     BUSINESS_OWNER  →  full control of ONE business
--     BUSINESS_USER   →  only explicitly granted capabilities
--
-- Legacy enum values are retained (Postgres cannot drop an enum value that
-- historical rows may reference) but no membership points at them after this
-- migration runs.
--
-- Least privilege is preserved on the way across: an old Read Only user does
-- NOT come out the other side able to start remote sessions.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. New enum values ──────────────────────────────────────────────────────
ALTER TYPE "RoleType" ADD VALUE IF NOT EXISTS 'BUSINESS_OWNER';
ALTER TYPE "RoleType" ADD VALUE IF NOT EXISTS 'BUSINESS_USER';

ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BUSINESS_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BUSINESS_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BUSINESS_DISABLED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'BUSINESS_DELETED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'USER_CAPABILITIES_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'PLATFORM_SETTINGS_UPDATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'QUICK_CONNECT_INITIATED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'QUICK_CONNECT_ENDED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'QUICK_CONNECT_DENIED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'QUICK_CONNECT_SETTING_CHANGED';
