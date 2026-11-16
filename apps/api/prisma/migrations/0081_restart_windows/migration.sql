-- v0.60: the simple restart window.
--
-- A restart window is set on a business (the default for its computers), on
-- a device group, or on one computer (which may also say "no automatic
-- restarts"). Precedence is computer > group (priority, 1 first) > business,
-- as for 0.35's group policies. A window is carried by an automation policy
-- (0.58) whose task is `restart`, approved on the approval signer like any
-- other: the signer decides every restart plan against that document. These
-- tables are the portal's settings and the history of what it asked for.
--
-- The database holds the rules so no code path can break them:
--
--   * RestartWindowSetting_scope_check: a business row names no group and no
--     computer; a group row names its group and a priority 1–999, and no
--     computer; a computer row names its computer, and no group or priority.
--   * RestartWindowSetting_mode_check: `window` stands on a policy; `off`
--     names none, and is never a business's (a business with no window is
--     simply one without a setting).
--   * One business row per business, and no two group rows of one business
--     share a priority (partial UNIQUE indexes).
--   * restart_window_same_business (trigger): the group, or the computer,
--     belongs to the row's own business.
--   * A computer that moves to another business leaves its own setting
--     behind (trigger on Endpoint): the window named it in the old business.
--   * The group's foreign key is NO ACTION: a group that carries a restart
--     window cannot be deleted until the setting is removed.
--   * RestartWindowAttempt_attempt_check: at most three restart plans per
--     computer per occurrence, the same bound the signer keeps itself.
--   * AutomationPolicy's task-kind CHECK gains 'restart'.

ALTER TYPE "ActivityAction" ADD VALUE 'RESTART_WINDOW_SET';
ALTER TYPE "ActivityAction" ADD VALUE 'RESTART_WINDOW_CLEARED';

ALTER TABLE "AutomationPolicy" DROP CONSTRAINT "AutomationPolicy_taskKind_check";
ALTER TABLE "AutomationPolicy" ADD CONSTRAINT "AutomationPolicy_taskKind_check" CHECK ("taskKind" IN ('script', 'software', 'restart'));

CREATE TABLE "RestartWindowSetting" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "groupId" TEXT,
    "endpointId" TEXT,
    "priority" INTEGER,
    "mode" TEXT NOT NULL,
    "policyId" TEXT,
    "pendingPolicyId" TEXT,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestartWindowSetting_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RestartWindowSetting_scope_check" CHECK (
         ("scope" = 'business' AND "groupId" IS NULL AND "endpointId" IS NULL AND "priority" IS NULL)
      OR ("scope" = 'group' AND "groupId" IS NOT NULL AND "endpointId" IS NULL AND "priority" BETWEEN 1 AND 999)
      OR ("scope" = 'computer' AND "endpointId" IS NOT NULL AND "groupId" IS NULL AND "priority" IS NULL)
    ),
    CONSTRAINT "RestartWindowSetting_mode_check" CHECK (
         ("mode" = 'window' AND "policyId" IS NOT NULL)
      OR ("mode" = 'off' AND "scope" <> 'business' AND "policyId" IS NULL AND "pendingPolicyId" IS NULL)
    ),
    CONSTRAINT "RestartWindowSetting_pending_check" CHECK ("pendingPolicyId" IS NULL OR "pendingPolicyId" <> "policyId")
);

CREATE UNIQUE INDEX "RestartWindowSetting_groupId_key" ON "RestartWindowSetting"("groupId");
CREATE UNIQUE INDEX "RestartWindowSetting_endpointId_key" ON "RestartWindowSetting"("endpointId");
CREATE INDEX "RestartWindowSetting_customerId_idx" ON "RestartWindowSetting"("customerId");
CREATE INDEX "RestartWindowSetting_policyId_idx" ON "RestartWindowSetting"("policyId");
CREATE UNIQUE INDEX "RestartWindowSetting_business_row" ON "RestartWindowSetting"("customerId") WHERE "scope" = 'business';
CREATE UNIQUE INDEX "RestartWindowSetting_group_priority_key" ON "RestartWindowSetting"("customerId", "priority") WHERE "scope" = 'group';

ALTER TABLE "RestartWindowSetting" ADD CONSTRAINT "RestartWindowSetting_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RestartWindowSetting" ADD CONSTRAINT "RestartWindowSetting_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "EndpointGroup"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "RestartWindowSetting" ADD CONSTRAINT "RestartWindowSetting_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RestartWindowSetting" ADD CONSTRAINT "RestartWindowSetting_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AutomationPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RestartWindowSetting" ADD CONSTRAINT "RestartWindowSetting_pendingPolicyId_fkey" FOREIGN KEY ("pendingPolicyId") REFERENCES "AutomationPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION restart_window_same_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."groupId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "EndpointGroup" g WHERE g.id = NEW."groupId" AND g."customerId" = NEW."customerId"
  ) THEN
    RAISE EXCEPTION 'RestartWindowSetting: group % is not a group of business %', NEW."groupId", NEW."customerId" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."endpointId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Endpoint" e WHERE e.id = NEW."endpointId" AND e."customerId" = NEW."customerId"
  ) THEN
    RAISE EXCEPTION 'RestartWindowSetting: computer % is not a computer of business %', NEW."endpointId", NEW."customerId" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER restart_window_setting_same_business
  BEFORE INSERT OR UPDATE OF "groupId", "endpointId", "customerId" ON "RestartWindowSetting"
  FOR EACH ROW EXECUTE FUNCTION restart_window_same_business();

-- A computer that changes business leaves its own restart window behind.
CREATE FUNCTION restart_window_leaves_with_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."customerId" IS DISTINCT FROM OLD."customerId" THEN
    DELETE FROM "RestartWindowSetting" WHERE "endpointId" = NEW.id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER endpoint_restart_window_leaves
  AFTER UPDATE OF "customerId" ON "Endpoint"
  FOR EACH ROW EXECUTE FUNCTION restart_window_leaves_with_business();

CREATE TABLE "RestartWindowAttempt" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "windowKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "jobId" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestartWindowAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RestartWindowAttempt_attempt_check" CHECK ("attempt" BETWEEN 1 AND 3)
);

CREATE UNIQUE INDEX "RestartWindowAttempt_policyId_endpointId_windowKey_attempt_key" ON "RestartWindowAttempt"("policyId", "endpointId", "windowKey", "attempt");
CREATE INDEX "RestartWindowAttempt_endpointId_createdAt_idx" ON "RestartWindowAttempt"("endpointId", "createdAt");
CREATE INDEX "RestartWindowAttempt_customerId_createdAt_idx" ON "RestartWindowAttempt"("customerId", "createdAt");

ALTER TABLE "RestartWindowAttempt" ADD CONSTRAINT "RestartWindowAttempt_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "AutomationPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RestartWindowAttempt" ADD CONSTRAINT "RestartWindowAttempt_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
