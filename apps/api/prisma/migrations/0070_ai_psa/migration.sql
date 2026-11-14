-- v0.48: AI providers (Settings → AI) and PSA ticket connectors.
--
-- AiSettings is a singleton: one active provider at a time. The API key is
-- AES-256-GCM ciphertext (ai/ai-settings.service.ts); apiKeyLast4 is the only
-- clear part, for "set · …abcd". AiAnswer caches an answer for a day, keyed
-- on the fingerprint of the redacted input — the input itself is not stored.
-- PsaConnector is one per scope ("global" or "b:<customerId>"); PsaTicket
-- records that a ticket was made (ids and the PSA's reference, no text).

ALTER TYPE "ActivityAction" ADD VALUE 'AI_SETTINGS_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'AI_SETTINGS_TESTED';
ALTER TYPE "ActivityAction" ADD VALUE 'AI_ASKED';
ALTER TYPE "ActivityAction" ADD VALUE 'AI_ANSWERED';
ALTER TYPE "ActivityAction" ADD VALUE 'PSA_CONNECTOR_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'PSA_TICKET_CREATED';
ALTER TYPE "ActivityAction" ADD VALUE 'PSA_TICKET_FAILED';

-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT,
    "authStyle" TEXT NOT NULL DEFAULT 'bearer',
    "apiKeyEnc" TEXT,
    "apiKeyLast4" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastTestAt" TIMESTAMP(3),
    "lastTestResult" TEXT,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiAnswer" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PsaConnector" (
    "id" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "customerId" TEXT,
    "kind" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "emailRecipientId" TEXT,
    "webhookUrl" TEXT,
    "webhookSecretEnc" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PsaConnector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PsaTicket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "endpointId" TEXT NOT NULL,
    "sourceRef" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "connectorKind" TEXT NOT NULL,
    "connectorScope" TEXT NOT NULL,
    "ref" TEXT,
    "url" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PsaTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiAnswer_cacheKey_key" ON "AiAnswer"("cacheKey");

-- CreateIndex
CREATE INDEX "AiAnswer_expiresAt_idx" ON "AiAnswer"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PsaConnector_scopeKey_key" ON "PsaConnector"("scopeKey");

-- CreateIndex
CREATE INDEX "PsaTicket_endpointId_createdAt_idx" ON "PsaTicket"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "PsaTicket_endpointId_fingerprint_idx" ON "PsaTicket"("endpointId", "fingerprint");

-- AddForeignKey
ALTER TABLE "PsaConnector" ADD CONSTRAINT "PsaConnector_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PsaTicket" ADD CONSTRAINT "PsaTicket_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The closed values, in the database as well as in the code.
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_singleton" CHECK ("id" = 'singleton');
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_provider" CHECK ("provider" IN ('anthropic', 'openai', 'openai_compatible'));
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_auth_style" CHECK ("authStyle" IN ('bearer', 'api-key'));
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_base_url" CHECK (("provider" = 'openai_compatible') = ("baseUrl" IS NOT NULL));
ALTER TABLE "PsaConnector" ADD CONSTRAINT "PsaConnector_kind" CHECK ("kind" IN ('email', 'webhook', 'clientst0r'));
ALTER TABLE "PsaConnector" ADD CONSTRAINT "PsaConnector_scope" CHECK (("scopeKey" = 'global' AND "customerId" IS NULL) OR ("customerId" IS NOT NULL AND "scopeKey" = 'b:' || "customerId"));
ALTER TABLE "PsaConnector" ADD CONSTRAINT "PsaConnector_email_target" CHECK ("kind" <> 'email' OR "emailRecipientId" IS NOT NULL);
ALTER TABLE "PsaConnector" ADD CONSTRAINT "PsaConnector_webhook_target" CHECK ("kind" <> 'webhook' OR "webhookUrl" LIKE 'https://%' OR "webhookUrl" LIKE 'http://127.0.0.1:%');
