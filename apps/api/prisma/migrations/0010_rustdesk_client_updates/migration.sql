-- RustDesk client update staging on RustdeskNode.
-- Both columns are nullable with no default, so this is additive and safe to
-- apply to a live database: existing rows are untouched and no table rewrite
-- is required.
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "updateRequestedAt" TIMESTAMP(3);
ALTER TABLE "RustdeskNode" ADD COLUMN IF NOT EXISTS "updateTargetVersion" TEXT;
