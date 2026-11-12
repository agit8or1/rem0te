-- The tray (0.36): a per-user tray icon for both Windows agents, chat in a
-- small HTTPS window (/assist), optional chat recording, support requests from
-- the tray with an optional resource-usage sample and screenshot, and a closed
-- list of self-help tools. docs/tray.md.
--   Endpoint.tray*            the tray's protocol, and a standard computer's tray key (hash only)
--   Customer.chatRecording    null = PlatformSettings.chatRecordingDefault
--   ChatConversation          who started it, and whether it is recorded (frozen at the start)
--   ChatMessage               technicianSeenAt: a technician's panel showed an END_USER message
--   AssistCode                one-time code, 60 s, exchanged once for an AssistSession cookie
--   AssistSession             the /assist page's cookie (hash only), ≤ 2 h, one conversation
--   SupportRequestAttachment  screenshot (≤ 700 KiB) or usage sample, on a support request
--   TraySelfHelpRun           which self-help tool ran, when, as whom, and the result
-- Message text and Windows account names never go into ActivityLog.

ALTER TYPE "ActivityAction" ADD VALUE 'CHAT_RECORDING_CHANGED';
ALTER TYPE "ActivityAction" ADD VALUE 'TRAY_PAIRED';
ALTER TYPE "ActivityAction" ADD VALUE 'TRAY_SELF_HELP';

-- AlterTable
ALTER TABLE "ChatConversation" ADD COLUMN     "recorded" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "startedBy" TEXT NOT NULL DEFAULT 'technician',
ALTER COLUMN "startedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "technicianSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "chatRecording" BOOLEAN;

-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "trayKeyHash" TEXT,
ADD COLUMN     "trayKeyId" TEXT,
ADD COLUMN     "trayPairedAt" TIMESTAMP(3),
ADD COLUMN     "trayProtocol" INTEGER;

-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "chatRecordingDefault" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "AssistCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "conversationId" TEXT,
    "localUser" TEXT,
    "via" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "conversationId" TEXT,
    "localUser" TEXT,
    "via" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportRequestAttachment" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "bytes" BYTEA,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportRequestAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraySelfHelpRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "customerId" TEXT,
    "endpointId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "localUser" TEXT,
    "via" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "offline" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "detail" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TraySelfHelpRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AssistCode_codeHash_key" ON "AssistCode"("codeHash");

-- CreateIndex
CREATE INDEX "AssistCode_endpointId_createdAt_idx" ON "AssistCode"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistCode_expiresAt_idx" ON "AssistCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AssistSession_tokenHash_key" ON "AssistSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AssistSession_endpointId_idx" ON "AssistSession"("endpointId");

-- CreateIndex
CREATE INDEX "AssistSession_expiresAt_idx" ON "AssistSession"("expiresAt");

-- CreateIndex
CREATE INDEX "SupportRequestAttachment_requestId_idx" ON "SupportRequestAttachment"("requestId");

-- CreateIndex
CREATE INDEX "TraySelfHelpRun_endpointId_startedAt_idx" ON "TraySelfHelpRun"("endpointId", "startedAt");

-- CreateIndex
CREATE INDEX "TraySelfHelpRun_startedAt_idx" ON "TraySelfHelpRun"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Endpoint_trayKeyId_key" ON "Endpoint"("trayKeyId");

-- AddForeignKey
ALTER TABLE "AssistCode" ADD CONSTRAINT "AssistCode_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistSession" ADD CONSTRAINT "AssistSession_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportRequestAttachment" ADD CONSTRAINT "SupportRequestAttachment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraySelfHelpRun" ADD CONSTRAINT "TraySelfHelpRun_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backstops for what the service already enforces.
ALTER TABLE "ChatConversation" ADD CONSTRAINT "ChatConversation_started_by" CHECK (
    ("startedBy" = 'technician' AND "startedById" IS NOT NULL) OR ("startedBy" = 'end_user' AND "startedById" IS NULL));
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_seen_end_user_only" CHECK (
    "sender" = 'END_USER' OR "technicianSeenAt" IS NULL);
ALTER TABLE "AssistCode" ADD CONSTRAINT "AssistCode_via" CHECK ("via" IN ('signed', 'tray_key'));
ALTER TABLE "AssistCode" ADD CONSTRAINT "AssistCode_short_lived" CHECK ("expiresAt" <= "createdAt" + interval '5 minutes');
ALTER TABLE "AssistSession" ADD CONSTRAINT "AssistSession_via" CHECK ("via" IN ('signed', 'tray_key'));
ALTER TABLE "AssistSession" ADD CONSTRAINT "AssistSession_short_lived" CHECK ("expiresAt" <= "createdAt" + interval '2 hours 1 minute');
ALTER TABLE "SupportRequestAttachment" ADD CONSTRAINT "SupportRequestAttachment_kind" CHECK (
    ("kind" = 'screenshot' AND "contentType" IN ('image/jpeg', 'image/png') AND "bytes" IS NOT NULL AND "sizeBytes" BETWEEN 1 AND 716800 AND octet_length("bytes") = "sizeBytes")
    OR ("kind" = 'usage' AND "contentType" = 'application/json' AND "data" IS NOT NULL AND "bytes" IS NULL));
ALTER TABLE "TraySelfHelpRun" ADD CONSTRAINT "TraySelfHelpRun_tool" CHECK (
    "tool" IN ('dns.check', 'dns.flush', 'ip.renew', 'net.test', 'net.details', 'rustdesk.restart'));
ALTER TABLE "TraySelfHelpRun" ADD CONSTRAINT "TraySelfHelpRun_status" CHECK (
    "status" IN ('running', 'succeeded', 'failed', 'refused'));
ALTER TABLE "TraySelfHelpRun" ADD CONSTRAINT "TraySelfHelpRun_via" CHECK ("via" IN ('signed', 'tray_key'));
-- The elevated tools exist only on the signed agent: a tray key cannot record one.
ALTER TABLE "TraySelfHelpRun" ADD CONSTRAINT "TraySelfHelpRun_elevated_signed_only" CHECK (
    "via" = 'signed' OR "tool" IN ('dns.check', 'net.test', 'net.details'));
