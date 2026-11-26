-- 0.90 (UX P1-4): a technician workspace preference. Presentation only: it
-- changes which pages the sidebar puts in front and grants nothing. The
-- closed list is apps/api/src/navigation/model.ts WORKSPACES, word for word
-- and in order (§96).
ALTER TABLE "UserNavPreference" ADD COLUMN "workspace" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "UserNavPreference" ADD CONSTRAINT "UserNavPreference_workspace_check" CHECK ("workspace" IN ('all', 'l1', 'l2', 'l3'));
