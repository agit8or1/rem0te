-- v0.67: false-positive reports, recommendations and reviewed alert quality
-- rules (monitoring/quality-rules.ts). A report records one person's view of
-- one alert and changes nothing else. A recommendation is never applied. A
-- rule changes what a monitor raises only once it is active, which needs a
-- simulation of its current text and an approver (two different people for a
-- high-risk rule); the CHECKs below hold that, and one active rule per scope
-- and match.

ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_FALSE_POSITIVE_REPORTED';
ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_RECOMMENDATION_DISMISSED';
ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_QUALITY_RULE_PROPOSED';
ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_QUALITY_RULE_EDITED';
ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_QUALITY_RULE_APPROVED';
ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_QUALITY_RULE_REJECTED';
ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_QUALITY_RULE_ROLLED_BACK';
ALTER TYPE "ActivityAction" ADD VALUE 'ALERT_QUALITY_RULE_EXPIRED';

-- CreateTable
CREATE TABLE "AlertFalsePositiveReport" (
    "id" TEXT NOT NULL,
    "alertId" TEXT,
    "tenantId" TEXT,
    "customerId" TEXT,
    "endpointId" TEXT,
    "ruleId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fingerprint" TEXT,
    "alertSeverity" "AlertSeverity" NOT NULL,
    "alertClass" TEXT,
    "alertTitle" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "comment" TEXT,
    "recommendPrevent" BOOLEAN NOT NULL,
    "recommendationId" TEXT,
    "reportedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertFalsePositiveReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertRuleRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "ruleKey" TEXT NOT NULL,
    "ruleId" TEXT,
    "fingerprint" TEXT,
    "facts" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reportCount" INTEGER NOT NULL DEFAULT 1,
    "reporters" JSONB NOT NULL,
    "reasons" JSONB NOT NULL,
    "endpointIds" JSONB NOT NULL,
    "firstReportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualityRuleId" TEXT,
    "dismissedById" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "dismissNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertRuleRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertQualityRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "scopeKind" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "endpointId" TEXT,
    "groupId" TEXT,
    "monitorRuleId" TEXT,
    "osFamily" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "justification" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "match" JSONB NOT NULL,
    "matchKey" TEXT NOT NULL,
    "behaviour" JSONB NOT NULL,
    "behaviourKind" TEXT NOT NULL,
    "temporary" BOOLEAN NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "reviewAt" TIMESTAMP(3),
    "reviewNotifiedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'pending',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "risk" TEXT NOT NULL,
    "riskReasons" JSONB NOT NULL,
    "allowBroad" BOOLEAN NOT NULL DEFAULT false,
    "simulation" JSONB,
    "simulatedRevision" INTEGER,
    "simulatedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "secondApprovedById" TEXT,
    "secondApprovedAt" TIMESTAMP(3),
    "rejectedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rolledBackById" TEXT,
    "rolledBackAt" TIMESTAMP(3),
    "closedNote" TEXT,
    "supersedesId" TEXT,
    "recommendationId" TEXT,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchedAt" TIMESTAMP(3),
    "shadowMatchCount" INTEGER NOT NULL DEFAULT 0,
    "shadowLastMatchedAt" TIMESTAMP(3),
    "dangerousMatchCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertQualityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertQualityRuleEvent" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actorId" TEXT,
    "revision" INTEGER NOT NULL,
    "snapshot" JSONB,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertQualityRuleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AlertFalsePositiveReport_customerId_createdAt_idx" ON "AlertFalsePositiveReport"("customerId", "createdAt");

-- CreateIndex
CREATE INDEX "AlertFalsePositiveReport_ruleKey_createdAt_idx" ON "AlertFalsePositiveReport"("ruleKey", "createdAt");

-- CreateIndex
CREATE INDEX "AlertFalsePositiveReport_fingerprint_idx" ON "AlertFalsePositiveReport"("fingerprint");

-- CreateIndex
CREATE INDEX "AlertFalsePositiveReport_reportedById_createdAt_idx" ON "AlertFalsePositiveReport"("reportedById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertFalsePositiveReport_alertId_reportedById_key" ON "AlertFalsePositiveReport"("alertId", "reportedById");

-- CreateIndex
CREATE INDEX "AlertRuleRecommendation_customerId_status_idx" ON "AlertRuleRecommendation"("customerId", "status");

-- CreateIndex
CREATE INDEX "AlertRuleRecommendation_status_lastReportedAt_idx" ON "AlertRuleRecommendation"("status", "lastReportedAt");

-- CreateIndex
CREATE INDEX "AlertQualityRule_status_idx" ON "AlertQualityRule"("status");

-- CreateIndex
CREATE INDEX "AlertQualityRule_customerId_status_idx" ON "AlertQualityRule"("customerId", "status");

-- CreateIndex
CREATE INDEX "AlertQualityRule_ruleKey_status_idx" ON "AlertQualityRule"("ruleKey", "status");

-- CreateIndex
CREATE INDEX "AlertQualityRuleEvent_ruleId_createdAt_idx" ON "AlertQualityRuleEvent"("ruleId", "createdAt");

-- AddForeignKey
ALTER TABLE "AlertFalsePositiveReport" ADD CONSTRAINT "AlertFalsePositiveReport_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "MonitorAlert"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertFalsePositiveReport" ADD CONSTRAINT "AlertFalsePositiveReport_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertFalsePositiveReport" ADD CONSTRAINT "AlertFalsePositiveReport_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertFalsePositiveReport" ADD CONSTRAINT "AlertFalsePositiveReport_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "AlertRuleRecommendation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertRuleRecommendation" ADD CONSTRAINT "AlertRuleRecommendation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "EndpointGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_monitorRuleId_fkey" FOREIGN KEY ("monitorRuleId") REFERENCES "MonitorRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "AlertQualityRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertQualityRuleEvent" ADD CONSTRAINT "AlertQualityRuleEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AlertQualityRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── What the application cannot be trusted to keep on its own ──────────────

ALTER TABLE "AlertFalsePositiveReport" ADD CONSTRAINT "AlertFalsePositiveReport_reason_check" CHECK ("reason" IN (
  'known_harmless', 'incorrect_severity', 'duplicate', 'expected_activity', 'incorrect_threshold', 'rule_too_broad', 'incorrect_correlation', 'other'));
ALTER TABLE "AlertFalsePositiveReport" ADD CONSTRAINT "AlertFalsePositiveReport_comment_check" CHECK ("comment" IS NULL OR char_length("comment") <= 1000);
-- "Other" needs an explanation.
ALTER TABLE "AlertFalsePositiveReport" ADD CONSTRAINT "AlertFalsePositiveReport_other_check" CHECK ("reason" <> 'other' OR char_length(coalesce("comment", '')) >= 3);
ALTER TABLE "AlertFalsePositiveReport" ADD CONSTRAINT "AlertFalsePositiveReport_fingerprint_check" CHECK ("fingerprint" IS NULL OR "fingerprint" ~ '^[0-9a-f]{32}$');

ALTER TABLE "AlertRuleRecommendation" ADD CONSTRAINT "AlertRuleRecommendation_status_check" CHECK ("status" IN ('open', 'converted', 'dismissed'));
ALTER TABLE "AlertRuleRecommendation" ADD CONSTRAINT "AlertRuleRecommendation_count_check" CHECK ("reportCount" >= 1);
ALTER TABLE "AlertRuleRecommendation" ADD CONSTRAINT "AlertRuleRecommendation_fingerprint_check" CHECK ("fingerprint" IS NULL OR "fingerprint" ~ '^[0-9a-f]{32}$');
-- One open recommendation per business, monitor and event signature: a second report adds to it.
CREATE UNIQUE INDEX "AlertRuleRecommendation_open_key" ON "AlertRuleRecommendation"(coalesce("customerId", ''), "ruleKey", coalesce("fingerprint", '')) WHERE "status" = 'open';

ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_scopeKind_check" CHECK ("scopeKind" IN ('endpoint', 'group', 'business', 'os', 'monitor', 'platform'));
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_status_check" CHECK ("status" IN ('pending', 'active', 'rejected', 'rolled_back', 'expired', 'superseded'));
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_risk_check" CHECK ("risk" IN ('normal', 'high'));
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_behaviour_check" CHECK ("behaviourKind" IN ('suppress', 'downgrade', 'require_count', 'require_repeats'));
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_os_check" CHECK ("osFamily" IS NULL OR "osFamily" IN ('windows', 'windows-client', 'windows-server', 'linux', 'macos'));
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_matchKey_check" CHECK ("matchKey" ~ '^[0-9a-f]{32}$');
-- The scope names exactly what it is about. A platform rule names no business.
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_scope_check" CHECK (
  ("scopeKind" = 'endpoint' AND "endpointId" IS NOT NULL AND "customerId" IS NOT NULL AND "groupId" IS NULL AND "monitorRuleId" IS NULL AND "osFamily" IS NULL AND "scopeKey" = 'e:' || "endpointId")
  OR ("scopeKind" = 'group' AND "groupId" IS NOT NULL AND "customerId" IS NOT NULL AND "endpointId" IS NULL AND "monitorRuleId" IS NULL AND "osFamily" IS NULL AND "scopeKey" = 'g:' || "groupId")
  OR ("scopeKind" = 'business' AND "customerId" IS NOT NULL AND "endpointId" IS NULL AND "groupId" IS NULL AND "monitorRuleId" IS NULL AND "osFamily" IS NULL AND "scopeKey" = 'b:' || "customerId")
  OR ("scopeKind" = 'os' AND "osFamily" IS NOT NULL AND "endpointId" IS NULL AND "groupId" IS NULL AND "monitorRuleId" IS NULL AND "scopeKey" = 'os:' || coalesce("customerId", '*') || ':' || "osFamily")
  OR ("scopeKind" = 'monitor' AND "monitorRuleId" IS NOT NULL AND "endpointId" IS NULL AND "groupId" IS NULL AND "osFamily" IS NULL AND "scopeKey" = 'm:' || "monitorRuleId")
  OR ("scopeKind" = 'platform' AND "customerId" IS NULL AND "endpointId" IS NULL AND "groupId" IS NULL AND "monitorRuleId" IS NULL AND "osFamily" IS NULL AND "scopeKey" = 'platform')
);
-- Temporary rules expire; permanent exceptions carry a review date. Never both, never neither.
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_expiry_check" CHECK (
  ("temporary" AND "expiresAt" IS NOT NULL AND "reviewAt" IS NULL) OR (NOT "temporary" AND "reviewAt" IS NOT NULL AND "expiresAt" IS NULL));
-- Nothing is active without an approver, a high-risk rule without a second
-- and different one, or anything without a simulation of the approved text.
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_approved_check" CHECK ("status" NOT IN ('active', 'rolled_back', 'expired', 'superseded') OR "approvedById" IS NOT NULL);
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_second_check" CHECK (
  "status" NOT IN ('active', 'rolled_back', 'expired', 'superseded') OR "risk" <> 'high' OR ("secondApprovedById" IS NOT NULL AND "secondApprovedById" <> "approvedById"));
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_simulated_check" CHECK ("status" <> 'active' OR "simulatedRevision" = "revision");
ALTER TABLE "AlertQualityRule" ADD CONSTRAINT "AlertQualityRule_counts_check" CHECK ("matchCount" >= 0 AND "shadowMatchCount" >= 0 AND "dangerousMatchCount" >= 0 AND "revision" >= 1);
-- At most one active rule per scope and match: a conflicting second one is refused here.
CREATE UNIQUE INDEX "AlertQualityRule_active_key" ON "AlertQualityRule"("scopeKey", "matchKey") WHERE "status" = 'active';

-- A rule stays inside the business it names: a computer's or group's rule is
-- that business's, and a rule on one monitor is that monitor's business (or
-- none, for a global monitor).
CREATE FUNCTION "alert_quality_rule_business"() RETURNS trigger AS $$
DECLARE owner TEXT;
BEGIN
  IF NEW."endpointId" IS NOT NULL THEN
    SELECT "customerId" INTO owner FROM "Endpoint" WHERE "id" = NEW."endpointId";
    IF owner IS DISTINCT FROM NEW."customerId" THEN RAISE EXCEPTION 'alert quality rule: the computer is not in this business'; END IF;
  END IF;
  IF NEW."groupId" IS NOT NULL THEN
    SELECT "customerId" INTO owner FROM "EndpointGroup" WHERE "id" = NEW."groupId";
    IF owner IS DISTINCT FROM NEW."customerId" THEN RAISE EXCEPTION 'alert quality rule: the group is not in this business'; END IF;
  END IF;
  IF NEW."monitorRuleId" IS NOT NULL THEN
    SELECT "customerId" INTO owner FROM "MonitorRule" WHERE "id" = NEW."monitorRuleId";
    IF owner IS DISTINCT FROM NEW."customerId" THEN RAISE EXCEPTION 'alert quality rule: the monitor is not this business''s'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "AlertQualityRule_business" BEFORE INSERT OR UPDATE OF "customerId", "endpointId", "groupId", "monitorRuleId" ON "AlertQualityRule"
  FOR EACH ROW EXECUTE FUNCTION "alert_quality_rule_business"();

ALTER TABLE "AlertQualityRuleEvent" ADD CONSTRAINT "AlertQualityRuleEvent_type_check" CHECK ("type" IN (
  'proposed', 'edited', 'simulated', 'approved', 'second_approval_needed', 'rejected', 'rolled_back', 'expired', 'superseded', 'restored', 'review_due'));
